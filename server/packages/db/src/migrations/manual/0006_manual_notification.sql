-- 0006_manual · notification 站内通知表 RLS 补齐（M5-A2 通知服务）
-- 依据：后端技术方案 02 §4.2 RLS 双保险——0001 的租户策略模板仅在建表时点的存量表上生效，
-- notification 为其后增补表，此处按同款模板补齐（幂等，schema_manual_migrations 防重放）。

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification TO tradepilot_app;

ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.notification;
CREATE POLICY tenant_isolation ON public.notification
  USING (org_id = current_setting('app.org_id', true)::text)
  WITH CHECK (org_id = current_setting('app.org_id', true)::text);
