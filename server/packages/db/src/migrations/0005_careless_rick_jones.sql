-- 0005 · knowledge_chunk.embedding 维度 1536 → 2048（P1：选用模型 doubao-embedding-vision 原生 2048 维，
-- 该模型不支持 OpenAI 兼容的 dimensions 截断参数，故以列维度对齐模型，而非反向截断）。
-- 依据：后端技术方案 06 §4 / 07 §2；维度常量 KNOWLEDGE_EMBEDDING_DIMENSIONS 同步为 2048。
--
-- 手工加固说明（同 0004 的处理方式）：
-- 1) ai_model_type/task_type 的新枚举标签由 manual/0011、manual/0014 幂等补齐，此处不重复 ALTER
--    （否则存量库重放会报 enum label already exists；且 ALTER TYPE ... ADD VALUE 不能在事务内执行）。
-- 2) 存量 1536 维向量与新列维度不兼容（无法隐式转换），必须先把向量置空再改列类型；
--    同时把受影响文档回置为 indexing，等待重建（重建入口：知识中心「重试」POST /knowledge/documents/:id/retry，
--    或流水线重跑），避免出现「status=indexed 但向量为空」的静默不一致。
-- 3) 必须先删除 hnsw 索引 idx_kchunk_embedding：pgvector 对 vector 类型的 hnsw 索引上限为 2000 维
--    （报错 "column cannot have more than 2000 dimensions for hnsw index"），ALTER COLUMN TYPE 会尝试
--    重建该索引并失败。检索改为精确余弦最近邻（包内 knowledge_search 的 `<=>` 路径，MVP 量级开销可接受）；
--    待数据量上升需要 ANN 时，再以 halfvec(2048) + `USING hnsw (embedding halfvec_cosine_ops)` 方案启用
--    （halfvec 上限 4000 维，另需一次列类型迁移）。manual/0001 中的 hnsw 创建已同步注释。
DROP INDEX IF EXISTS "idx_kchunk_embedding";--> statement-breakpoint
UPDATE "knowledge_chunk" SET "embedding" = NULL WHERE "embedding" IS NOT NULL;--> statement-breakpoint
UPDATE "knowledge_document"
   SET "status" = 'indexing', "error" = NULL, "indexed_at" = NULL
 WHERE "id" IN (SELECT DISTINCT "document_id" FROM "knowledge_chunk");--> statement-breakpoint
ALTER TABLE "knowledge_chunk" ALTER COLUMN "embedding" SET DATA TYPE vector(2048);--> statement-breakpoint
COMMENT ON COLUMN "knowledge_chunk"."embedding" IS '向量嵌入（2048 维，精确余弦检索；迁移 0005 由 1536 调整，hnsw 待 halfvec 方案启用）';
