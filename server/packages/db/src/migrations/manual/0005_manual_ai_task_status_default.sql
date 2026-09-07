-- 0005_manual · ai_task.status 默认值校正（M3-17）
-- 依据：后端技术方案 04 §2/§5.2「任务恒落 scheduled，running 由 Runner.claim 独占置位并补 started_at」。
-- 原默认 'running' 会诱导未来误插入「running + started_at 空」的不可恢复直投态（M3-01 根因同源），
-- 统一改为 'scheduled' 与落库语义一致。
-- 幂等：ALTER ... SET DEFAULT 重复执行结果一致 + schema_manual_migrations 跟踪表防重放（src/migrate.ts 按序执行）。

ALTER TABLE public.ai_task ALTER COLUMN status SET DEFAULT 'scheduled';
COMMENT ON COLUMN public.ai_task.status IS '任务状态（默认 scheduled；running 由 Runner.claim 置位并补 started_at；waiting_approval 不占并发）';
