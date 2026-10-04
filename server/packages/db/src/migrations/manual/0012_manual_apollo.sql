-- 0012_manual · ai_model.type 新增 apollo（Apollo 相似客户获客）
-- 依据：Apollo.io 客户数据供应商也走「系统设置 → AI 模型配置」台账（与 search 同模式，
-- 存 provider=apollo + baseUrl + apiKey），不与 type=search（Serper web 搜索）混用，
-- 避免选用冲突导致 web_search 工厂解析失败。
-- 幂等（pg_enum 存在性检查），由 src/migrate.ts 在 drizzle 产物之后按序执行（schema_manual_migrations 防重放）。
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.ai_model_type'::regtype AND enumlabel = 'apollo'
  ) THEN
    ALTER TYPE public.ai_model_type ADD VALUE 'apollo';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'apollo_run_status'
  ) THEN
    CREATE TYPE public.apollo_run_status AS ENUM ('keywords_ready', 'searched', 'analyzed', 'failed');
  END IF;
END $$;

-- Apollo 获客运行表（四步工作流中间产物落库）
CREATE TABLE IF NOT EXISTS "apollo_search_run" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"seed_customer_id" text NOT NULL,
	"created_by" text NOT NULL,
	"status" "apollo_run_status" DEFAULT 'keywords_ready' NOT NULL,
	"seed_profile" "jsonb" NOT NULL,
	"search_params" "jsonb",
	"results" "jsonb",
	"analyze_results" "jsonb",
	"total_companies" integer DEFAULT 0 NOT NULL,
	"qualified_count" integer DEFAULT 0 NOT NULL,
	"saved_lead_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apollo_run_org_created" ON "apollo_search_run" ("org_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apollo_run_org_seed" ON "apollo_search_run" ("org_id", "seed_customer_id");
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apollo_search_run_org_id_org_id_fk') THEN
  ALTER TABLE "apollo_search_run" ADD CONSTRAINT "apollo_search_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apollo_search_run_seed_customer_id_customer_id_fk') THEN
  ALTER TABLE "apollo_search_run" ADD CONSTRAINT "apollo_search_run_seed_customer_id_customer_id_fk" FOREIGN KEY ("seed_customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
-- RLS 双保险（与 0001 模板同口径；0001 不会对新表重放，故此处补齐）
ALTER TABLE "apollo_search_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "apollo_search_run" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "apollo_search_run";
CREATE POLICY tenant_isolation ON "apollo_search_run"
  USING (org_id = current_setting('app.org_id', true)::text)
  WITH CHECK (org_id = current_setting('app.org_id', true)::text);
