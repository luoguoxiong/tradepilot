-- 0004_manual · ai_task 跟进任务活跃唯一索引（M3-04）
-- 依据：后端技术方案 04 §3.1「多实例部署安全」/ §5.2 幂等三层。
-- FollowUpScanner 多 worker 实例并发预检同一 follow_up_task 时，tick 内的活跃 ai_task 预筛
-- 是独立快照，存在 TOCTOU：两个实例均可能通过预检后各自插入一条 follow_up ai_task。
-- 行级防御见 apps/worker/src/scheduler/follow-up-scanner.ts（preCheck 内 FOR UPDATE SKIP LOCKED
-- 领取 + 锁内复核）；本索引用作 DB 层兜底：同一 followUpTaskId 只允许一条活跃任务
-- （status ∈ scheduled/running/waiting_approval），与扫描器 busy 判定口径一致。
-- 索引建在 ai_task.input ->> 'followUpTaskId'（不新增列/不回填；既有代码全部经 jsonb 访问该字段）。
-- 幂等：IF NOT EXISTS + schema_manual_migrations 跟踪表防重放（由 src/migrate.ts 按序执行）。

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_task_active_followup
  ON public.ai_task ((input ->> 'followUpTaskId'))
  WHERE status IN ('scheduled', 'running', 'waiting_approval')
    AND (input ->> 'followUpTaskId') IS NOT NULL;
