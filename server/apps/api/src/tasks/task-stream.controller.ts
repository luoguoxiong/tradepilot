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
 * 单用户连接上限 5（进程内计数，MVP API 单实例）。
 */
const MAX_CONNECTIONS_PER_USER = 5;
const HEARTBEAT_MS = 15_000;
const REPLAY_BATCH = 200;
const REPLAY_MAX_ROUNDS = 5;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

@Controller('tasks')
export class TaskStreamController {
  private readonly connections = new Map<string, number>();

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

    // ① 任务校验（开流前，404 可正常走异常过滤器）
    const task = await withOrg(this.db, orgId, async (tx) => {
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
    if (!task) {
      throw BizException.notFound(`任务不存在: ${taskId}`);
    }

    // ② 连接上限（开流前拒绝）
    const current = this.connections.get(user.sub) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_USER) {
      throw BizException.bizValidation(`SSE 连接数超上限（${MAX_CONNECTIONS_PER_USER}）`);
    }
    this.connections.set(user.sub, current + 1);

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
    const onMessage = (ch: string, message: string): void => {
      if (ch !== channel) {
        return;
      }
      try {
        const parsed = JSON.parse(message) as { type?: string };
        write(parsed.type ?? 'log', parsed);
      } catch {
        // 非契约消息忽略
      }
    };
    subscriber.on('message', onMessage);
    await subscriber.subscribe(channel);

    // ⑤ 回放：after 之后的日志 + 当前状态快照
    try {
      let after = query.after;
      for (let round = 0; round < REPLAY_MAX_ROUNDS; round += 1) {
        const page = await this.replayLogs(orgId, taskId, after, REPLAY_BATCH);
        for (const log of page.items) {
          write('log', log);
        }
        if (!page.hasMore) {
          break;
        }
        after = page.items[page.items.length - 1]?.logId;
      }
      write('status', {
        status: task.status,
        ...(task.linkedApprovalId ? { linkedApprovalId: task.linkedApprovalId } : {}),
        ...(task.error ? { error: task.error } : {}),
      });
      if (TERMINAL_STATUSES.has(task.status)) {
        write('done', {
          status: task.status,
          outputs: task.outputs ?? [],
          ...(task.error ? { error: task.error } : {}),
        });
        await this.cleanup(subscriber, user.sub, res);
        return;
      }
    } catch {
      await this.cleanup(subscriber, user.sub, res);
      return;
    }

    // ⑥ 心跳 + 断开清理
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      void this.cleanup(subscriber, user.sub, res);
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

  private async cleanup(subscriber: Redis, userId: string, res: Response): Promise<void> {
    const count = (this.connections.get(userId) ?? 1) - 1;
    if (count <= 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, count);
    }
    await subscriber.unsubscribe().catch(() => undefined);
    await subscriber.quit().catch(() => subscriber.disconnect());
    res.end();
  }
}
