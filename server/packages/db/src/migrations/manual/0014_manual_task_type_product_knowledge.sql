-- 0014_manual · task_type 新增 product_knowledge（08 产品中心：产品资料解析 → 结构化入库 → 知识生成）
-- 依据：08 产品中心 §4.1 —— 产品知识生成走独立任务类型，避免与 M5-C4 已占用的 product_analysis
--       （客户购买意向分析）语义冲突；队列归属同 q.knowledge_index（shared TASK_TYPE_QUEUE）。
-- 幂等（pg_enum 存在性检查），由 src/migrate.ts 在 drizzle 产物之后按序执行（schema_manual_migrations 防重放）。
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.task_type'::regtype AND enumlabel = 'product_knowledge'
  ) THEN
    ALTER TYPE public.task_type ADD VALUE 'product_knowledge';
  END IF;
END $$;
