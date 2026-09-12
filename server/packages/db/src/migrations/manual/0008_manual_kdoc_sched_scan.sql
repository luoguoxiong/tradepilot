-- ============ 8. knowledge_document 加入 sched_scan SELECT 白名单（02 §4.3 / M4 #7） ============
-- 背景（#5/#6 联调发现）：q:knowledge_index 知识入库流水线（worker 端）以 sched 上下文
-- 跨租户按 docId 定位文档（knowledge-index.ts ①），但 knowledge_document 缺 sched_scan
-- SELECT 策略 → 被 tenant_isolation 拦截（app.org_id 空）→ 返回空 → job 恒为
-- skipped/missing，文档永远停在 indexing。补白名单策略（permissive，与 tenant_isolation 为 OR 关系：
-- sched=1 放行跨租户扫描；常规 API 会话仍按 app.org_id 隔离）。
DROP POLICY IF EXISTS sched_scan ON public.knowledge_document;
CREATE POLICY sched_scan ON public.knowledge_document
  FOR SELECT
  USING (current_setting('app.sched', true)::text = '1');
