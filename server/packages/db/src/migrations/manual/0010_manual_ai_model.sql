-- 0010_manual · ai_model AI 模型台账表 RLS 补齐（16 FR-10 扩展：模型清单 + org 级选用）
-- 依据：后端技术方案 02 §4.2 RLS 双保险——0001 的租户策略模板仅在建表时点的存量表上生效，
-- ai_model 为其后增补表，此处按同款模板补齐（幂等，schema_manual_migrations 防重放）。

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model TO tradepilot_app;

ALTER TABLE public.ai_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.ai_model;
CREATE POLICY tenant_isolation ON public.ai_model
  USING (org_id = current_setting('app.org_id', true)::text)
  WITH CHECK (org_id = current_setting('app.org_id', true)::text);
