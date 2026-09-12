-- 0011_manual · ai_model.type 新增 search（16 FR-10 扩展：搜索供应商也走「系统设置 → AI 模型配置」）
-- 依据：后端技术方案 06 §3——web_search / site_crawl 的外部供应商由 org 在系统设置页配置，
-- 与 llm / embedding 共用 ai_model 台账（type=search 存 provider=http/mock + baseUrl + apiKey）。
-- 幂等（pg_enum 存在性检查），由 src/migrate.ts 在 drizzle 产物之后按序执行（schema_manual_migrations 防重放）。
-- 说明：不放入 drizzle 生成的 0004，否则存量库重放该迁移会报 enum label already exists。
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.ai_model_type'::regtype AND enumlabel = 'search'
  ) THEN
    ALTER TYPE public.ai_model_type ADD VALUE 'search';
  END IF;
END $$;
