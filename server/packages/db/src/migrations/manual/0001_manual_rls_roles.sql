-- 0001_manual · 扩展 + 三 DB 角色 + RLS 双保险 + 跨模块 FK + 表达式索引
-- 依据：后端技术方案 02 §2.2/§4、ER 02/03/04/05/07 §3 跨模块补齐注、02 §6.2 索引清单。
-- 全文幂等（IF NOT EXISTS / DO 块），由 src/migrate.ts 在 drizzle 产物之后按序执行。

-- ============ 1. 扩展 ============
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============ 2. 三 DB 角色（02 §4.1） ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_app') THEN
    CREATE ROLE tradepilot_app LOGIN PASSWORD 'changeme_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_sched') THEN
    CREATE ROLE tradepilot_sched LOGIN PASSWORD 'changeme_sched';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_migrate') THEN
    CREATE ROLE tradepilot_migrate LOGIN PASSWORD 'changeme_migrate' NOINHERIT;
  END IF;
END $$;

-- app 角色：业务表通用 CRUD（RLS 生效，无 BYPASSRLS）
GRANT USAGE ON SCHEMA public TO tradepilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tradepilot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tradepilot_app;

-- sched 角色：仅白名单表 SELECT/UPDATE（跨租户扫描，绕 RLS 需配合策略放行，见下）
GRANT USAGE ON SCHEMA public TO tradepilot_sched;
GRANT SELECT, UPDATE ON
  follow_up_task, approval_request, mailbox, ai_task, analytics_daily_summary
  TO tradepilot_sched;

-- migrate 角色：仅迁移流水线使用（运行时不可用；不授业务表权限）
-- DDL 由表 owner（迁移连接角色）执行，migrate 角色供流水线专用连接串。

-- ============ 3. RLS 策略模板（02 §4.2） ============
-- 对所有含 org_id 的业务表统一套用 tenant_isolation（ENABLE + FORCE）。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'org_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (org_id = current_setting(''app.org_id'', true)::text)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::text)',
      r.table_name
    );
  END LOOP;

  -- org 表（租户根，无 org_id 列）：按 id 隔离
  ALTER TABLE public.org ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.org FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON public.org;
  CREATE POLICY tenant_isolation ON public.org
    USING (id = current_setting('app.org_id', true)::text)
    WITH CHECK (id = current_setting('app.org_id', true)::text);

  -- user_account 追加 login_lookup（03 §1.1）：登录上下文（app.login='1'）允许按 email 全局定位
  DROP POLICY IF EXISTS login_lookup ON public.user_account;
  CREATE POLICY login_lookup ON public.user_account
    FOR SELECT
    USING (current_setting('app.login', true)::text = '1');

  -- sched 角色扫描放行：白名单表追加 sched_scan 策略（02 §4.3：扫出后逐任务仍以 withOrg 执行）
  DROP POLICY IF EXISTS sched_scan ON public.follow_up_task;
  CREATE POLICY sched_scan ON public.follow_up_task FOR SELECT USING (current_setting('app.sched', true)::text = '1');
  DROP POLICY IF EXISTS sched_scan ON public.approval_request;
  CREATE POLICY sched_scan ON public.approval_request FOR SELECT USING (current_setting('app.sched', true)::text = '1');
  DROP POLICY IF EXISTS sched_scan ON public.mailbox;
  CREATE POLICY sched_scan ON public.mailbox FOR SELECT USING (current_setting('app.sched', true)::text = '1');
  DROP POLICY IF EXISTS sched_scan ON public.ai_task;
  CREATE POLICY sched_scan ON public.ai_task FOR SELECT USING (current_setting('app.sched', true)::text = '1');
  DROP POLICY IF EXISTS sched_scan ON public.analytics_daily_summary;
  CREATE POLICY sched_scan ON public.analytics_daily_summary FOR SELECT USING (current_setting('app.sched', true)::text = '1');
END $$;

-- ============ 4. 跨模块 FK 补齐（各 ER §3 注） ============
-- 04 建表后补 03：ai_lead.converted_customer_id → customer
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_customer') THEN
    ALTER TABLE ai_lead ADD CONSTRAINT fk_lead_customer
      FOREIGN KEY (converted_customer_id) REFERENCES customer(id);
  END IF;
END $$;

-- 03 建表后补 04：customer.source_lead_id → ai_lead（ER 04 §2.1 注）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_customer_source_lead') THEN
    ALTER TABLE customer ADD CONSTRAINT fk_customer_source_lead
      FOREIGN KEY (source_lead_id) REFERENCES ai_lead(id);
  END IF;
END $$;

-- 08 建表后补 02：ai_task.linked_approval_id → approval_request
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_approval') THEN
    ALTER TABLE ai_task ADD CONSTRAINT fk_task_approval
      FOREIGN KEY (linked_approval_id) REFERENCES approval_request(id);
  END IF;
END $$;

-- 08 建表后补 07：quotation.approval_id → approval_request
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quote_approval') THEN
    ALTER TABLE quotation ADD CONSTRAINT fk_quote_approval
      FOREIGN KEY (approval_id) REFERENCES approval_request(id);
  END IF;
END $$;

-- 08 建表后补 05：follow_up_execution.approval_id → approval_request
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fexec_approval') THEN
    ALTER TABLE follow_up_execution ADD CONSTRAINT fk_fexec_approval
      FOREIGN KEY (approval_id) REFERENCES approval_request(id);
  END IF;
END $$;

-- ER 06 §2.5：product_knowledge.status CHECK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_product_knowledge_status') THEN
    ALTER TABLE product_knowledge ADD CONSTRAINT ck_product_knowledge_status
      CHECK (status IN ('draft', 'approved'));
  END IF;
END $$;

-- ER 06 §2.6：knowledge_document.source CHECK（含 email_attachment，ER 06 v0.4）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_knowledge_doc_source') THEN
    ALTER TABLE knowledge_document ADD CONSTRAINT ck_knowledge_doc_source
      CHECK (source IN ('upload', 'product', 'email_attachment'));
  END IF;
END $$;

-- ER 08 §3：ai_discovery.status CHECK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ai_discovery_status') THEN
    ALTER TABLE ai_discovery ADD CONSTRAINT ck_ai_discovery_status
      CHECK (status IN ('new', 'executed', 'dismissed'));
  END IF;
END $$;

-- ER 08 §3：order_risk_insight.status CHECK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_order_risk_status') THEN
    ALTER TABLE order_risk_insight ADD CONSTRAINT ck_order_risk_status
      CHECK (status IN ('active', 'resolved'));
  END IF;
END $$;

-- ============ 5. 表达式索引（02 §6.2） ============
-- keyword 模糊搜索（pg_trgm）
CREATE INDEX IF NOT EXISTS idx_ai_lead_name_trgm ON ai_lead USING gin (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customer_name_trgm ON customer USING gin (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_name_trgm ON product USING gin (name gin_trgm_ops);

-- 向量检索（pgvector；数据量上来后启用）
CREATE INDEX IF NOT EXISTS idx_kchunk_embedding ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
