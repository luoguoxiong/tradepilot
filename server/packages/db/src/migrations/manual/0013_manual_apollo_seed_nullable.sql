-- 0013_manual · apollo_search_run.seed_customer_id 放宽为可空
-- 依据：种子客户支持「手动输入公司名」（种子公司不必存在于 CRM），
-- 手动模式下 seed_customer_id 为 NULL，种子画像完整存 seed_profile JSONB。
-- 幂等，由 src/migrate.ts 按序执行（schema_manual_migrations 防重放）。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'apollo_search_run'
      AND column_name = 'seed_customer_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.apollo_search_run ALTER COLUMN seed_customer_id DROP NOT NULL;
  END IF;
END $$;
