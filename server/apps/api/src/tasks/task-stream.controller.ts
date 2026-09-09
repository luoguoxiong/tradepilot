import { Inject, Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { BizException } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { logAfterQuerySchema, taskEventChannel } from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

/**
 * SSE 管道（后端技术方案 04 §6 / 接口 14 §3.4）：
 * 订阅先行（Redis SUBSCRIBE task:{id}:events）→ 按 after=logId 回放历史日志 → 当前 status
 * （终态补发 done 后关闭）→ 实时转发 → 15s 心跳。防丢事件：先订阅后回放，客户端按 seq 去重。
 * 去重（M3-09）：回放与实时双通道都可能投递同一 log（订阅成功到回放之间 PUBLISH），服务端按 logId 去重。
 * 连接泄漏（M3-10）：subscribe 抛错路径同样走 cleanup 递减连接计数。
 * 终态丢失窗口（M3-03）：开流前快照仅作 404 校验；订阅成功后再读一次 DB 作为 status/done 依据——
 * Worker 先提交终态再 PUBLISH，故此刻 DB 已可见，读快照(running)与订阅成功之间的终态提交不会丢。
 * commit→PUBLISH 崩溃窗口（M3-11）：Worker 提交终态事务后、PUBLISH done 前崩溃 → 已开流客户端
 * 收不到 done 会永久挂等心跳。兜底：对非终态连接每 5s 重读任务行（04 §6.3），DB 已终态且本连接
 * 未发过 done → 按 DB 最新态补发 status+done 并关闭，弥合该崩溃窗口。
 * 连接上限（04 §6.1 契约）：单用户 ≤ 10 条 SSE、org ≤ 200，超限 `42901`；
 * 进程内计数（MVP API 单实例），多实例共享计数随 M4 部署扩展（Redis 计数）。
 */
const MAX_CONNECTIONS_PER_USER = 10;
/** org 级 SSE 连接上限（04 §6.1：org ≤ 200，超限 42901） */
const MAX_CONNECTIONS_PER_ORG = 200;
const HEARTBEAT_MS = 15_000;
/** M3-11 终态兜底轮询周期（04 §6.3：覆盖 Worker commit→PUBLISH 之间崩溃的丢 done 窗口） */
const TERMINAL_POLL_MS = 5_000;
const REPLAY_BATCH = 200;
const REPLAY_MAX_ROUNDS = 5;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

@Controller('tasks')
export class TaskStreamController {
  private readonly connections = new Map<string, number>();
  private readonly orgConnections = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get(':id/stream')
  @RawResponse()
  async stream(
    @Param('id') taskId: string,
    @Query(new ZodValidationPipe(logAfterQuerySchema)) query: { after?: string; limit: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    const orgId = user.orgId;

    // ① 任务校验（开流前，404 可正常走异常过滤器）；status 不在此时定稿，见 ⑤ 重读
    const task = await this.loadTask(orgId, taskId);
    if (!task) {
      throw BizException.notFound(`任务不存在: ${taskId}`);
    }

    // ② 连接上限（开流前拒绝；04 §6.1：单用户 ≤ 10 / org ≤ 200，超限 42901）
    const current = this.connections.get(user.sub) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_USER) {
      throw BizException.rateLimited(`SSE 连接数超单用户上限（${MAX_CONNECTIONS_PER_USER}）`);
    }
    const orgCurrent = this.orgConnections.get(orgId) ?? 0;
    if (orgCurrent >= MAX_CONNECTIONS_PER_ORG) {
      throw BizException.rateLimited(`SSE 连接数超 org 上限（${MAX_CONNECTIONS_PER_ORG}）`);
    }
    this.connections.set(user.sub, current + 1);
    this.orgConnections.set(orgId, orgCurrent + 1);

    // ③ 开流
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const write = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // ④ 订阅先行（防丢：订阅成功后才回放）
    const subscriber = this.redis.duplicate();
    const channel = taskEventChannel(taskId);
    // M3-09 去重：先订阅后回放期间 PUBLISH 的日志会被「回放查询」与「订阅回调」双收，
    // 以 ai_task_log.logId 为唯一键（文档 04 §6.1 的 seq/logId 去重），先到者发出并登记、后到者丢弃。
    const sentLogIds = new Set<string>();
    // 统一 log 事件契约（04 §6.1）：data 形状恒为 { type:'log', payload:{ logId, ... } }，
    // 回放（payload 取自 DB 行）与实时（payload 取自 PUBLISH 消息）同构，客户端按 payload.logId 去重。
    const sendLog = (logId: string, payload: unknown): void => {
      if (sentLogIds.has(logId)) {
        return;
      }
      sentLogIds.add(logId);
      write('log', { type: 'log', payload });
    };
    // M3-11 终态兜底（04 §6.3）：本连接 done 一经投递（实时到达或兜底补发）即置位；
    // DB 已终态且未置位 → 补发 status+done 并关闭，弥合 Worker commit→PUBLISH 崩溃的丢 done 窗口。
    let doneSent = false;
    let terminalPoll: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const stopTerminalPoll = (): void => {
      if (terminalPoll) {
        clearInterval(terminalPoll);
        terminalPoll = undefined;
      }
    };
    // M3-03 终态关闭：done 实时到达即关闭流（回放/兜底/实时三路径统一走此出口），
    // 杜绝客户端收 done 后仍挂等心跳。
    const finishDone = async (data: Record<string, unknown>): Promise<void> => {
      doneSent = true;
      stopTerminalPoll();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      write('done', data);
      await this.cleanup(subscriber, user.sub, orgId, res);
    };
    const onMessage = (ch: string, message: string): void => {
      if (ch !== channel) {
        return;
      }
      try {
        const parsed = JSON.parse(message) as { type?: string; payload?: { logId?: string } };
        if (parsed.type === 'log' && typeof parsed.payload?.logId === 'string') {
          sendLog(parsed.payload.logId, parsed.payload);
          return;
        }
        if (parsed.type === 'done') {
          if (!doneSent) {
            void finishDone(parsed as Record<string, unknown>);
          }
          return; // done 已（将）关闭流，不再 write 其它事件
        }
        write(parsed.type ?? 'log', parsed);
      } catch {
        // 非契约消息忽略
      }
    };
    subscriber.on('message', onMessage);
    try {
      await subscriber.subscribe(channel);
    } catch {
      // M3-10：subscribe 抛错路径（Redis 异常等）同样走 cleanup 递减连接计数，防泄漏；
      // 响应头已 flush 无法改状态码，直接收尾断开。
      await this.cleanup(subscriber, user.sub, orgId, res);
      return;
    }

    // ⑤ 回放：after 之后的日志 + 当前状态快照
    try {
      let after = query.after;
      for (let round = 0; round < REPLAY_MAX_ROUNDS; round += 1) {
        const page = await this.replayLogs(orgId, taskId, after, REPLAY_BATCH);
        for (const log of page.items) {
          sendLog(log.logId, log);
        }
        if (!page.hasMore) {
          break;
        }
        after = page.items[page.items.length - 1]?.logId;
      }

      // 订阅成功后再读一次任务行（M3-03）：Worker 先提交终态再 PUBLISH（complete/fail 于
      // 事务提交后发布），故此刻 DB 终态必已可见——弥合 ① 读快照与订阅成功之间的提交窗口：
      // 已终态则按 DB 最新态补发 status+done 并关闭，杜绝客户端挂等心跳。
      const latest = await this.loadTask(orgId, taskId);
      if (!latest) {
        await this.cleanup(subscriber, user.sub, orgId, res);
        return;
      }
      write('status', {
        status: latest.status,
        ...(latest.linkedApprovalId ? { linkedApprovalId: latest.linkedApprovalId } : {}),
        ...(latest.error ? { error: latest.error } : {}),
      });
      if (TERMINAL_STATUSES.has(latest.status)) {
        await finishDone({
          status: latest.status,
          outputs: latest.outputs ?? [],
          ...(latest.error ? { error: latest.error } : {}),
        });
        return;
      }
    } catch {
      await this.cleanup(subscriber, user.sub, orgId, res);
      return;
    }

    // ⑤.5 M3-11 终态兜底轮询（04 §6.3）：Worker「commit 终态 → PUBLISH done」之间崩溃时，
    // 实时通道与回放都不含该 done（回放只补 ai_task_log）→ 客户端会永久挂等心跳。
    // 周期重读任务行：DB 已终态且本连接未发过 done → 按 DB 最新态补发 status+done 并关闭。
    const pollTerminal = async (): Promise<void> => {
      try {
        const latest = await this.loadTask(orgId, taskId);
        if (!latest || !TERMINAL_STATUSES.has(latest.status)) {
          return; // 未终态 → 下轮再查
        }
        if (!doneSent) {
          write('status', {
            status: latest.status,
            ...(latest.linkedApprovalId ? { linkedApprovalId: latest.linkedApprovalId } : {}),
            ...(latest.error ? { error: latest.error } : {}),
          });
          await finishDone({
            status: latest.status,
            outputs: latest.outputs ?? [],
            ...(latest.error ? { error: latest.error } : {}),
          });
        }
      } catch {
        // 单轮查询失败静默：下个周期重试
      }
    };
    terminalPoll = setInterval(() => void pollTerminal(), TERMINAL_POLL_MS);
    terminalPoll.unref?.();

    // ⑥ 心跳 + 断开清理
    heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on('close', () => {
      stopTerminalPoll();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      void this.cleanup(subscriber, user.sub, orgId, res);
    });
  }

  /** 读任务行（org 隔离；SSE 状态快照的统一数据源） */
  private async loadTask(orgId: string, taskId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.aiTask.id,
          status: schema.aiTask.status,
          outputs: schema.aiTask.outputs,
          error: schema.aiTask.error,
          linkedApprovalId: schema.aiTask.linkedApprovalId,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      return row ?? null;
    });
  }

  /** after 游标增量读日志（复用 14 §3.3 口径） */
  private async replayLogs(orgId: string, taskId: string, after?: string, limit = REPLAY_BATCH) {
    return withOrg(this.db, orgId, async (tx) => {
      const conditions = [eq(schema.aiTaskLog.taskId, taskId)];
      if (after) {
        conditions.push(sql`${schema.aiTaskLog.id} > ${after}`);
      }
      const rows = await tx
        .select({
          id: schema.aiTaskLog.id,
          occurredAt: schema.aiTaskLog.occurredAt,
          type: schema.aiTaskLog.type,
          content: schema.aiTaskLog.content,
          leadId: schema.aiTaskLog.leadId,
        })
        .from(schema.aiTaskLog)
        .where(and(...conditions))
        .orderBy(schema.aiTaskLog.id)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => ({
        logId: r.id,
        time: r.occurredAt.toISOString(),
        type: r.type,
        content: r.content,
        ...(r.leadId ? { leadId: r.leadId } : {}),
      }));
      return { items, hasMore };
    });
  }

  private async cleanup(
    subscriber: Redis,
    userId: string,
    orgId: string,
    res: Response,
  ): Promise<void> {
    // 幂等防重入：finishDone 与 req.close 可能并发触发 cleanup，仅首个执行关闭；
    // 标记挂在 subscriber 实例上，避免双重递减连接计数 / 重复 res.end。
    if ((subscriber as unknown as { __cleaned?: boolean }).__cleaned) {
      return;
    }
    (subscriber as unknown as { __cleaned?: boolean }).__cleaned = true;

    const count = (this.connections.get(userId) ?? 1) - 1;
    if (count <= 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, count);
    }
    const orgCount = (this.orgConnections.get(orgId) ?? 1) - 1;
    if (orgCount <= 0) {
      this.orgConnections.delete(orgId);
    } else {
      this.orgConnections.set(orgId, orgCount);
    }
    // 先关闭响应，让客户端立即收到流结束（done 后不再等待 subscriber 清理）；
    // subscriber 退订/断开为收尾，失败不影响客户端语义。
    res.end();
    await subscriber.unsubscribe().catch(() => undefined);
    await subscriber.quit().catch(() => subscriber.disconnect());
  }
}
