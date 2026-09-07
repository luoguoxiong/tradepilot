/**
 * 员工终态回写前置校验（后端技术方案 04 §3.3 / M3-06）：
 * 任务终态（completed / failed / approval_expired / timeout）回写员工 idle 前，
 * 先确认该员工已无其它占用任务（running / waiting_approval，排除当前终态任务）。
 * 避免并发缺陷场景下「任务 A 结束把正在跑任务 B 的员工误置 idle / 互相覆盖」。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@tradepilot/db';
import { EMPLOYEE_OCCUPYING_TASK_STATUSES, EMPLOYEE_STATUS } from '@tradepilot/shared';

export interface ReleaseEmployeeIdleParams {
  employeeId: string;
  /** 刚置终态的任务 id（排除自身，其余 active 任务才算占用） */
  excludeTaskId: string;
  now: Date;
}

/**
 * 若员工无其它 active 任务则回写 idle（须与终态任务 update 同事务调用）。
 * @returns true=已回 idle；false=员工仍持有其它占用任务，保持现状态由占用任务终态再收口
 */
export async function releaseEmployeeIdle(tx: Tx, p: ReleaseEmployeeIdleParams): Promise<boolean> {
  const [active] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.aiTask)
    .where(
      and(
        eq(schema.aiTask.employeeId, p.employeeId),
        sql`${schema.aiTask.id} <> ${p.excludeTaskId}`,
        inArray(schema.aiTask.status, [...EMPLOYEE_OCCUPYING_TASK_STATUSES]),
      ),
    );
  if ((active?.n ?? 0) > 0) {
    return false;
  }
  await tx
    .update(schema.aiEmployee)
    .set({ status: EMPLOYEE_STATUS.IDLE, statusDetail: null, updatedAt: p.now })
    .where(eq(schema.aiEmployee.id, p.employeeId));
  return true;
}
