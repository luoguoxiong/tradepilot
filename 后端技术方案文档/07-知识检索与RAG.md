# 后端技术方案 · 07 · 知识检索与 RAG

| 项 | 内容 |
|---|---|
| 前置文档 | 需求口径 = [11-知识中心](../产品需求文档/11-知识中心.md)（格式/上限/软删/权限已澄清）；数据层 = [ER 06](../产品需求文档/PostgreSQL%20数据库%20ER%20图/06-产品与知识模块.md)（knowledge_document / knowledge_chunk，vector(1536)）；嵌入 = [06 §4](./06-外部集成设计.md) |
| 版本 | v0.1（2026-09-06） |

---

## 1. 定位与硬约束

- **知识库是 AI 事实的唯一来源**（11 §4）：检索直查向量库，**无长缓存**（引用实时失效语义）；AI 引用必须可追溯到 docId/chunkId。
- 业务参数（产品参数/MOQ/交期/报价规则）只允许来自结构化数据（06 §4 / D9）：P0 来源 = 知识中心；无依据 → `grounded=false + missingInfo`，不阻塞。
- 检索/引用 org 级全量共享，不按角色过滤；删除/重试仅 manager/admin（11 §7.3）。

## 2. 入库流水线（q:knowledge_index）

```text
POST /knowledge/documents（multipart，白名单 pdf/docx/md/txt，≤50MB 超限 42201）
→ magic number 复核真实类型（防伪装扩展名，08 §7）
→ 对象存储存储原文（key: kdoc/{orgId}/{docId}.{ext}）
→ knowledge_document(category 人工选, source, status='indexing') → 入队 knowledge_index
→ 图/批处理任务：
   ① parse：pdf→unpdf（含 OCR 兜底 P1）；docx→mammoth；md/txt 直读
   ② clean：去页眉页脚、全角归一、去重空白
   ③ chunk：结构感知分块——标题层级优先切分，块长 ~500 token（overlap ~10%），
      每块带 { heading_path, page? } 元数据
   ④ embed：批量嵌入（100/批）→ knowledge_chunk 批量插入（embedding vector(1536)，
      tsv 全文列同步生成，§4）
   ⑤ status='indexed' + SSE/轮询可见（Documents/Chunks 统计实时聚合，FR-05）
   失败 → status='failed' + error 文案；重试仅 manager/admin（重跑 ①起）
```

- 进度按文档数推进（LangGraph 工作流 §8）；单文档处理超时 10min → failed。
- **覆盖式更新** = 软删旧文档（deleted_at/deleted_by）+ 新文档新 ID 走全流水线，引用不迁移（11 §7.2）。

## 3. 删除语义（软删留痕，事务）

```text
DELETE /knowledge/documents/{id}
→ 单事务：
   knowledge_document SET deleted_at=now(), deleted_by=ctx.userId
   knowledge_chunk 物理删除（含向量）→ 检索天然不可命中
→ 历史引用（报价依据/草稿/审批 outputs 中的 docId）回溯：
   引用解析服务按 id 查文档行（含软删）→ 返回标题/分类/来源/上传人 + 标记「已删除」
```

- repository 层默认过滤 `deleted_at IS NULL`；引用回溯走显式 `withDeleted()` 变体（[02 §6.1](./02-数据访问层设计.md)）。

## 4. 检索服务（knowledge_search 工具）

### 4.1 混合检索

```text
input: { scene, query, topK=5, filters?{ category, knowledge_scope } }
① 向量：query 嵌入 → HNSW（vector_cosine_ops）Top-20
   WHERE org_id=（RLS）AND document_id IN (未软删) AND category ∈ scope
② 关键词：tsvector 全文（websearch_to_tsquery）Top-20，同过滤
③ 融合：RRF（k=60）排序 → 取 Top-K
④ 后处理：同文档多块合并相邻块；返回 { chunkId, docId, docName, content, score }
```

- **场景差异化**（knowledge_search_scene 枚举）：

| scene | 召回策略差异 |
|---|---|
| `lead_match` | category 偏 `product`；摘要级（块内容截断 800 token） |
| `sales_reply` | `product + faq + sales + company`；携带 heading_path |
| `follow_up` | `product + sales`（Case 素材） |
| `pricing_basis`（P1） | `product + process`；供 pricing_engine 引用 |
| `business_analysis`（P1） | 全类目，Top-K 提至 10 |

- 性能：单次检索 P95 < 300ms（HNSW `ef_search=64` 起步，压测调参）；连接级 prepared statement。

### 4.2 引用链（citations）

- 节点产出引用 = `{ docId, chunkId, docName }`（Insight Schema §4.1 契约）；写入 `insight.citations` / 草稿 outputs。
- 引用实时性保证：检索时直查、无缓存；chunk 已物理删除 → 引用解析服务降级展示「已删除」。

## 5. 全量重建与维度迁移

| 触发 | 流程 |
|---|---|
| 嵌入模型/维度变更 | 校验存量维度 ≠ 新维度 → 拒绝增量混存；提供重建任务：清空全部 chunks → 按文档逐个重跑流水线（限速跑批，索引状态回 `indexing`） |
| 检索质量调优 | 分块参数/融合权重进配置（env + 可调 service 常量）；A/B 时以场景命中率指标（11 §6）评估 |

## 6. 产品知识（P1，08 启用）

- `product_analysis` 任务：产品资料（product_document）→ 解析 → `product_knowledge` 结构化摘要（overview/卖点/规格问答）→ 同 chunk 化入库（category='product'）。
- 自动归档（D11）：product_document 上传 → 自动建 knowledge_document（source='product_archive'）——随 08 启用，P0 手动上传不受影响。
- **红线**：产品知识生成排除 `cost_price`（防下游草稿/报价泄漏，项目决议）；prompt 输入层物理剔除该字段。

## 7. 观测指标

| 指标 | 来源 |
|---|---|
| 索引成功率 / 平均时长 | knowledge_index 任务终态聚合 |
| 检索 P95 / Top-K 命中分布 | knowledge_search 工具埋点（OTel span attribute） |
| AI 回复引用命中率、「知识库无依据」提示率 | outputs.grounded / missingInfo 统计（11 §6，15 数据中心 P1 展示） |
