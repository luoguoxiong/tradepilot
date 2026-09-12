/**
 * 02 AI 数字员工中心服务（接口 02 §3，M5-C3）：
 * - list：员工卡片列表（status 语义 / todayStats 今日任务计数 / kpi / currentTask 只读聚合 ai_task / workspacePath）；
 * - roles：创建向导预填（sop_template is_preset=true + 预置 ai_employee 派生 RoleTemplate）；
 * - create：仅 admin/manager（sales 越权 40301）；role / kpiConfig.metric / approvalPolicy.quote
 *   业务校验（42201）；sopParams 合并进 org 级 sop_template 副本（is_preset=false）；
 * - listTasks：该员工任务列表（复用 TasksService.list 按 employeeId 过滤）；
 * - pause/resume：员工级暂停/恢复（02 §2/§3.4，MVP 口径见方法注释）。
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { BizException, ErrorCode, createId } from '@tradepilot/core';
import { schema, withOrg, type Db, type OrgScopeContext, type Tx } from '@tradepilot/db';
import { buildStatusEvent, TaskEventPublisher } from '@tradepilot/runtime';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { TasksService } from '../tasks/tasks.service.js';
import {
  EMPLOYEE_ROLES,
  ROLE_KPI_METRIC,
  type CreateEmployeeDto,
  type EmployeeRole,
} from './employees.dto.js';

/** 工作台路由（02 §1.2 承载决策；D4：跟单/经理占位 → null 禁用入口） */
const WORKSPACE_PATH: Record<EmployeeRole, string | null> = {
  lead_hunter: '/lead-gen',
  customer_researcher: '/crm',
  sales: '/inbox',
  follow_up: '/follow-up',
  merchandiser: null,
  manager: null,
};

/** todayStats 文案（02 §1.1 今日工作量；MVP 口径 = 今日任务计数，02 §3 兜底） */
const TODAY_STAT_LABEL: Record<EmployeeRole, { label: string; unit: string }> = {
  lead_hunter: { label: '今日获客任务', unit: '个' },
  customer_researcher: { label: '今日分析任务', unit: '个' },
  sales: { label: '今日询盘任务', unit: '个' },
  follow_up: { label: '今日跟进任务', unit: '个' },
  merchandiser: { label: '今日跟单任务', unit: '个' },
  manager: { label: '今日经营任务', unit: '个' },
};

/** D4 占位角色（跟单/经理）：KPI 随 P1 模块启用后展示 → null */
const PLACEHOLDER_ROLES: readonly EmployeeRole[] = ['merchandiser', 'manager'];

/** db employee_status → 前端卡片状态（02 §1.1 四种语义色；scheduled 归 idle、risk/failed 归 error） */
const CARD_STATUS: Record<string, 'working' | 'idle' | 'waiting_approval' | 'error'> = {
  working: 'working',
  waiting_approval: 'waiting_approval',
  idle: 'idle',
  scheduled: 'idle',
  risk: 'error',
  failed: 'error',
};

/** SOP 高级设置参数 label 兜底映射（前端渲染参数微调） */
const SOP_PARAM_LABEL: Record<string, string> = {
  match_product: '产品匹配分档阈值',
};

export interface EmployeeCurrentTask {
  taskId: string;
  title: string;
  taskType: string;
  status: string;
  progressPct: number;
  currentStep?: string;
}

export interface EmployeeKpi {
  metric: string;
  achieved: number;
  target: number;
  progressPct: number;
  period: 'daily';
}

export interface EmployeeCard {
  employeeId: string;
  role: EmployeeRole;
  name: string;
  avatar?: string;
  status: 'working' | 'idle' | 'waiting_approval' | 'error';
  statusDetail: string | null;
  todayStats: { label: string; count: number; unit: string }[];
  kpi: EmployeeKpi | null;
  currentTask: EmployeeCurrentTask | null;
  workspacePath: string | null;
}

export interface SopParamDef {
  key: string;
  label: string;
  type: 'number' | 'select';
  options?: { value: string; label: string }[];
  defaultValue: string | number;
  unit?: string;
}

export interface RoleTemplate {
  role: EmployeeRole;
  name: string;
  goal: string;
  sopTemplateId: string;
  sopParams: Record<string, string | number>;
  sopParamDefs: SopParamDef[];
  skills: string[];
  tools: string[];
  knowledgeScope: string[];
  memoryConfig: { retentionDays: number; scope: string };
  kpiConfig: { metric: string; target: number; period: 'daily' };
}

@Injectable()
export class EmployeesService {
  private readonly publisher: TaskEventPublisher;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(REDIS) redis: Redis,
  ) {
    this.publisher = new TaskEventPublisher(redis);
  }

  /** 02 §3.1 员工卡片列表（全量 6 卡；status 语义 / todayStats / kpi / currentTask / workspacePath） */
  async list(
    ctx: OrgScopeContext,
    page: number,
    pageSize: number,
  ): Promise<{ items: EmployeeCard[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const employees = await tx
        .select()
        .from(schema.aiEmployee)
        .where(eq(schema.aiEmployee.orgId, ctx.orgId))
        .orderBy(asc(schema.aiEmployee.createdAt));

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 今日任务计数（按员工分组；02 §3.1 今日工作量 MVP 口径）
      const todayRows = await tx
        .select({
          employeeId: schema.aiTask.employeeId,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.orgId, ctx.orgId),
            sql`${schema.aiTask.createdAt} >= ${today.toISOString()}`,
          ),
        )
        .groupBy(schema.aiTask.employeeId);
      const todayCount = new Map(todayRows.map((r) => [r.employeeId, r.n]));

      // 当前任务（FR-04/D5）：该员工最新一条非终态 ai_task（不依赖 14 接口）
      const activeRows = await tx
        .select({
          employeeId: schema.aiTask.employeeId,
          taskId: schema.aiTask.id,
          title: schema.aiTask.title,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          progressPct: schema.aiTask.progressPct,
          currentStep: schema.aiTask.currentStep,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.orgId, ctx.orgId),
            sql`${schema.aiTask.status} not in ('completed', 'failed', 'canceled')`,
          ),
        )
        .orderBy(desc(schema.aiTask.createdAt));
      const currentByEmployee = new Map<string, EmployeeCurrentTask>();
      for (const row of activeRows) {
        if (!currentByEmployee.has(row.employeeId)) {
          currentByEmployee.set(row.employeeId, {
            taskId: row.taskId,
            title: row.title,
            taskType: row.type,
            status: row.status,
            progressPct: row.progressPct,
            ...(row.currentStep ? { currentStep: row.currentStep } : {}),
          });
        }
      }

      const cards: EmployeeCard[] = employees.map((emp) => {
        const role = emp.role as EmployeeRole;
        const currentTask = currentByEmployee.get(emp.id) ?? null;
        // 状态语义（02 §1.1）：优先 ai_employee.status；有 running 任务 → working
        const status =
          currentTask?.status === 'running' ? 'working' : (CARD_STATUS[emp.status] ?? 'idle');
        const statLabel = TODAY_STAT_LABEL[role] ?? { label: '今日任务', unit: '个' };

        // KPI（02 §1.1）：占位角色（跟单/经理 D4）→ null；其余取 kpiConfig + 今日任务计数
        let kpi: EmployeeKpi | null = null;
        if (emp.kpiConfig && !PLACEHOLDER_ROLES.includes(role)) {
          const achieved = todayCount.get(emp.id) ?? 0;
          kpi = {
            metric: emp.kpiConfig.metric,
            achieved,
            target: emp.kpiConfig.target,
            progressPct: Math.min(100, Math.round((achieved / emp.kpiConfig.target) * 100)),
            period: 'daily',
          };
        }

        return {
          employeeId: emp.id,
          role,
          name: emp.name,
          ...(emp.avatar ? { avatar: emp.avatar } : {}),
          status,
          statusDetail: emp.statusDetail ?? null,
          todayStats: [
            { label: statLabel.label, count: todayCount.get(emp.id) ?? 0, unit: statLabel.unit },
          ],
          kpi,
          currentTask,
          workspacePath: WORKSPACE_PATH[role] ?? null,
        };
      });

      const total = cards.length;
      const start = (page - 1) * pageSize;
      const items = cards.slice(start, start + pageSize);

      return { items, total, page, pageSize };
    });
  }

  /** 02 §2 角色模板清单（创建向导预填：sop_template is_preset=true + 预置 ai_employee 派生） */
  async roles(ctx: OrgScopeContext): Promise<RoleTemplate[]> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const rows = await tx
        .select({
          sopId: schema.sopTemplate.id,
          role: schema.sopTemplate.role,
          sopName: schema.sopTemplate.name,
          content: schema.sopTemplate.content,
          employeeName: schema.aiEmployee.name,
          goal: schema.aiEmployee.goal,
          skills: schema.aiEmployee.skills,
          tools: schema.aiEmployee.tools,
          knowledgeScope: schema.aiEmployee.knowledgeScope,
          memoryConfig: schema.aiEmployee.memoryConfig,
          kpiConfig: schema.aiEmployee.kpiConfig,
        })
        .from(schema.sopTemplate)
        .leftJoin(
          schema.aiEmployee,
          and(
            eq(schema.aiEmployee.sopTemplateId, schema.sopTemplate.id),
            eq(schema.aiEmployee.orgId, schema.sopTemplate.orgId),
          ),
        )
        .where(and(eq(schema.sopTemplate.orgId, ctx.orgId), eq(schema.sopTemplate.isPreset, true)))
        .orderBy(asc(schema.sopTemplate.createdAt));

      return rows.map((row) => {
        const role = row.role as EmployeeRole;
        const { sopParams, sopParamDefs } = this.deriveSopParams(row.content?.advancedSettings);
        const memory = row.memoryConfig ?? {};
        const kpi = row.kpiConfig ?? {
          metric: ROLE_KPI_METRIC[role],
          target: 0,
          period: 'daily' as const,
        };
        return {
          role,
          name: row.employeeName ?? this.stripSopSuffix(row.sopName),
          goal: row.goal ?? '',
          sopTemplateId: row.sopId,
          sopParams,
          sopParamDefs,
          skills: row.skills ?? [],
          tools: row.tools ?? [],
          knowledgeScope: row.knowledgeScope ?? [],
          memoryConfig: {
            retentionDays: memory.retentionDays ?? 180,
            scope: memory.scope ?? 'org',
          },
          kpiConfig: kpi,
        };
      });
    });
  }

  /** 02 §3.2 创建 AI 员工（仅 admin/manager；sales 越权 40301） */
  async create(ctx: OrgScopeContext, dto: CreateEmployeeDto): Promise<{ employeeId: string }> {
    // 创建/修改员工为高权限操作（02 §3.1：role ∈ {admin, manager}）
    this.assertManager(ctx);
    // role 必填且属于 6 角色枚举（非法 → 42201）
    if (!(EMPLOYEE_ROLES as readonly string[]).includes(dto.role)) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, `未知员工角色: ${dto.role}`);
    }
    const role = dto.role as EmployeeRole;
    // kpiConfig.metric 按角色枚举校验（非法 → 42201）
    if (dto.kpiConfig.metric !== ROLE_KPI_METRIC[role]) {
      throw new BizException(
        ErrorCode.BIZ_VALIDATION,
        `kpiConfig.metric 与角色不匹配（${role} 应为 ${ROLE_KPI_METRIC[role]}）`,
      );
    }
    // 6 类高风险动作审批绑定红线：quote 不可为 none/缺失（非法 → 42201）
    if (dto.approvalPolicy.quote !== 'always') {
      throw new BizException(
        ErrorCode.BIZ_VALIDATION,
        '高风险动作（quote）必须绑定审批，不可设为 none',
      );
    }

    return withOrg(this.db, ctx.orgId, async (tx) => {
      // 解析 SOP 模板（优先传入，否则取该角色预置），sopParams 合并进 org 级副本（is_preset=false）
      const source = await this.resolveSopTemplate(tx, ctx.orgId, role, dto.sopTemplateId);
      // sopParams 键须为模板已定义参数（02 §3.2：未定义键 → 42201）
      const definedKeys = new Set(Object.keys(source.content.advancedSettings ?? {}));
      const unknownKeys = Object.keys(dto.sopParams ?? {}).filter((k) => !definedKeys.has(k));
      if (unknownKeys.length > 0) {
        throw new BizException(
          ErrorCode.BIZ_VALIDATION,
          `sopParams 含模板未定义的参数键: ${unknownKeys.join(', ')}`,
        );
      }
      const sopTemplateId = await this.copySopTemplate(tx, ctx.orgId, role, dto, source);

      const employeeId = createId('emp');
      await tx.insert(schema.aiEmployee).values({
        id: employeeId,
        orgId: ctx.orgId,
        role,
        name: dto.name,
        status: 'idle',
        goal: dto.goal,
        sopTemplateId,
        skills: [...dto.skills],
        tools: [...dto.tools],
        knowledgeScope: [...dto.knowledgeScope],
        memoryConfig: dto.memoryConfig ?? { retentionDays: 180, scope: 'org' },
        workflowId: dto.workflowId ?? null,
        permissions: dto.permissions,
        approvalPolicy: {
          // email_send 缺省 high_value_only（16 §4；服务层兜底 zod default——直调不经 Pipe）
          email_send: dto.approvalPolicy.email_send ?? 'high_value_only',
          quote: 'always',
          autoExecute: [...dto.approvalPolicy.autoExecute],
        },
        kpiConfig: dto.kpiConfig,
        createdBy: ctx.userId,
      });

      return { employeeId };
    });
  }

  /**
   * 02 §2/§3.4 暂停员工（MVP 口径）：
   * - 仅作用于「执行中」任务（ai_task.status=running，与接口文案一致）；paused 不占员工并发位，
   *   员工回 idle（当前卡无 running 则恢复空闲）——worker 侧正在执行的任务由 Runner 节点级
   *   PauseAbort 协作中断收口（DB 置 paused 后节点前探测中止，终态写回带 status 前置防覆盖）；
   * - waiting_approval（审批挂起）任务不随员工暂停：审批单独立于员工停摆，批准后照常 resume；
   * - 名下 scheduled 排队任务保持不动（员工空闲后由 Dispatcher 照常投递，属「暂停后新排期」，
   *   管理员可通过暂停时段内不派新任务 + 逐个任务处置来收口，MVP 不阻断队列语义）。
   */
  async pause(
    ctx: OrgScopeContext,
    employeeId: string,
  ): Promise<{ employeeId: string; pausedTasks: number }> {
    this.assertManager(ctx);
    const now = new Date();
    const pausedTaskIds = await withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertEmployee(tx, ctx.orgId, employeeId);
      const rows = await tx
        .update(schema.aiTask)
        .set({ status: 'paused', updatedAt: now })
        .where(and(eq(schema.aiTask.employeeId, employeeId), eq(schema.aiTask.status, 'running')))
        .returning({ id: schema.aiTask.id });
      if (rows.length > 0) {
        // running 任务占用期间员工必 working；全部暂停后释放员工位
        await tx
          .update(schema.aiEmployee)
          .set({ status: 'idle', statusDetail: null, updatedAt: now })
          .where(
            and(eq(schema.aiEmployee.id, employeeId), eq(schema.aiEmployee.status, 'working')),
          );
        // 留痕（task_log_type 无 pause 取值，随额度耗尽 paused 先例用 error 语义记录中止）
        for (const row of rows) {
          await tx.insert(schema.aiTaskLog).values({
            id: createId('tlog'),
            orgId: ctx.orgId,
            taskId: row.id,
            occurredAt: now,
            type: 'error',
            content: 'AI 员工已暂停，任务中止（人工 resume 后从检查点恢复执行）',
            leadId: null,
          });
        }
      }
      return rows.map((r) => r.id);
    });
    // 事务提交后推送 SSE status=paused（订阅方刷新卡片/流；runner 收尾不再重复推送）
    for (const taskId of pausedTaskIds) {
      await this.publisher.publish(taskId, buildStatusEvent({ status: 'paused' }));
    }
    return { employeeId, pausedTasks: pausedTaskIds.length };
  }

  /**
   * 02 §2/§3.4 恢复员工：名下全部 paused 任务 → scheduled（Dispatcher 按员工并发=1 依次投递续跑；
   * checkpointer 超步幂等保证 resume 不重发已完成的步骤/工具）。恢复仅改变任务排期，不触发审批。
   */
  async resume(
    ctx: OrgScopeContext,
    employeeId: string,
  ): Promise<{ employeeId: string; resumedTasks: number }> {
    this.assertManager(ctx);
    const now = new Date();
    const resumed = await withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertEmployee(tx, ctx.orgId, employeeId);
      const rows = await tx
        .update(schema.aiTask)
        .set({ status: 'scheduled', updatedAt: now })
        .where(and(eq(schema.aiTask.employeeId, employeeId), eq(schema.aiTask.status, 'paused')))
        .returning({ id: schema.aiTask.id });
      return rows.length;
    });
    return { employeeId, resumedTasks: resumed };
  }

  /** 02 §3.3 该员工任务列表（复用 tasks 模块列表按 employeeId 过滤） */
  async listTasks(
    ctx: OrgScopeContext,
    employeeId: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    await withOrg(this.db, ctx.orgId, (tx) => this.assertEmployee(tx, ctx.orgId, employeeId));
    return this.tasks.list(ctx.orgId, { employeeId, page, pageSize });
  }

  // ===== helpers =====

  /** 创建/修改/暂停员工为高权限操作（02 §3.1：role ∈ {admin, manager}；sales 越权 40301） */
  private assertManager(ctx: OrgScopeContext): void {
    if (ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '仅经理/管理员可操作 AI 员工（02 §3.1）');
    }
  }

  /** 校验员工存在且属于本 org（不存在 → 40401） */
  private async assertEmployee(tx: Tx, orgId: string, employeeId: string): Promise<void> {
    const [emp] = await tx
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.id, employeeId), eq(schema.aiEmployee.orgId, orgId)))
      .limit(1);
    if (!emp) {
      throw new BizException(ErrorCode.NOT_FOUND, `AI 员工不存在: ${employeeId}`);
    }
  }

  /** 解析 SOP 模板：传入 id 优先（须属本 org），否则取该角色模板（预置优先） */
  private async resolveSopTemplate(
    tx: Tx,
    orgId: string,
    role: EmployeeRole,
    sopTemplateId?: string,
  ): Promise<typeof schema.sopTemplate.$inferSelect> {
    if (sopTemplateId) {
      const [t] = await tx
        .select()
        .from(schema.sopTemplate)
        .where(and(eq(schema.sopTemplate.id, sopTemplateId), eq(schema.sopTemplate.orgId, orgId)))
        .limit(1);
      if (!t) {
        throw new BizException(ErrorCode.NOT_FOUND, `SOP 模板不存在: ${sopTemplateId}`);
      }
      return t;
    }
    const [t] = await tx
      .select()
      .from(schema.sopTemplate)
      .where(and(eq(schema.sopTemplate.orgId, orgId), eq(schema.sopTemplate.role, role)))
      .orderBy(desc(schema.sopTemplate.isPreset))
      .limit(1);
    if (!t) {
      throw new BizException(ErrorCode.NOT_FOUND, `未找到 ${role} 的 SOP 模板`);
    }
    return t;
  }

  /** 派生 org 级 SOP 副本（is_preset=false），sopParams 合并进 advancedSettings（02 §3.1） */
  private async copySopTemplate(
    tx: Tx,
    orgId: string,
    role: EmployeeRole,
    dto: CreateEmployeeDto,
    source: typeof schema.sopTemplate.$inferSelect,
  ): Promise<string> {
    const advancedSettings = { ...(source.content.advancedSettings ?? {}) };
    if (dto.sopParams) {
      for (const [key, value] of Object.entries(dto.sopParams)) {
        advancedSettings[key] = value;
      }
    }
    const id = createId('sop');
    await tx.insert(schema.sopTemplate).values({
      id,
      orgId,
      role,
      name: `${dto.name}·SOP`,
      content: { ...source.content, advancedSettings },
      isPreset: false,
    });
    return id;
  }

  /** 从预置 advancedSettings 派生 sopParams + sopParamDefs（02 §3.1 参数级微调） */
  private deriveSopParams(advancedSettings: Record<string, unknown> | undefined): {
    sopParams: Record<string, string | number>;
    sopParamDefs: SopParamDef[];
  } {
    const sopParams: Record<string, string | number> = {};
    const sopParamDefs: SopParamDef[] = [];
    if (!advancedSettings) {
      return { sopParams, sopParamDefs };
    }
    for (const [key, value] of Object.entries(advancedSettings)) {
      // 分档阈值对象 { tier: threshold } → select 参数（默认选中最高档）
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        );
        if (entries.length > 0) {
          const defaultValue = entries[0]![0];
          sopParams[key] = defaultValue;
          sopParamDefs.push({
            key,
            label: SOP_PARAM_LABEL[key] ?? key,
            type: 'select',
            options: entries.map(([tier, threshold]) => ({
              value: tier,
              label: `${tier[0]!.toUpperCase()}${tier.slice(1)}（≥ ${threshold} 分）`,
            })),
            defaultValue,
          });
          continue;
        }
      }
      // 纯数值 → number 参数
      if (typeof value === 'number') {
        sopParams[key] = value;
        sopParamDefs.push({
          key,
          label: SOP_PARAM_LABEL[key] ?? key,
          type: 'number',
          defaultValue: value,
        });
      }
    }
    return { sopParams, sopParamDefs };
  }

  /** 去掉预置 SOP 名后缀（`·预置SOP`）作为员工名称兜底 */
  private stripSopSuffix(name: string): string {
    return name.replace(/·预置SOP$/, '');
  }
}
