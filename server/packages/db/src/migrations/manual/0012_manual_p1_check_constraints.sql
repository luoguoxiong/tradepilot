-- 0012_manual · 补齐 ER DDL 声明但 drizzle 契约未表达的 CHECK 约束
-- 依据：P1-DB-01/03/04 数据层校核（P1 表/枚举已就位，逐字段比对发现「区间类 CHECK」遗漏）。
-- 范围：ER 02 §2（progress_pct 已由 drizzle 0001 ck_task_progress 覆盖）、
--       03 §2.2/§2.3、04 §2.1/§2.2/§2.4、05 §2.3、06 §2.3、07 §2.2~§2.5、08 §3。
-- 说明：Drizzle schema 不支持 CHECK，统一在 manual 迁移交付（与 0001 §4 同策略）；
--       幂等（pg_constraint 存在性检查），由 src/migrate.ts 在 drizzle 产物之后按序执行。
--       区间类约束对存量行做一次性校验：若报错说明既有数据越界，属需修复的真实脏数据。

-- ER 06 §2.3：product_price_tier.min_qty（起始数量 > 0）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_price_tier_min_qty') THEN
    ALTER TABLE product_price_tier ADD CONSTRAINT ck_price_tier_min_qty
      CHECK (min_qty > 0);
  END IF;
END $$;

-- ER 07 §2.2：quotation_item.quantity（数量 > 0）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_quotation_item_qty') THEN
    ALTER TABLE quotation_item ADD CONSTRAINT ck_quotation_item_qty
      CHECK (quantity > 0);
  END IF;
END $$;

-- ER 07 §2.3：sales_order.production_pct（生产进度 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sales_order_production_pct') THEN
    ALTER TABLE sales_order ADD CONSTRAINT ck_sales_order_production_pct
      CHECK (production_pct BETWEEN 0 AND 100);
  END IF;
END $$;

-- ER 07 §2.4：sales_order_item.quantity（数量 > 0）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_sales_order_item_qty') THEN
    ALTER TABLE sales_order_item ADD CONSTRAINT ck_sales_order_item_qty
      CHECK (quantity > 0);
  END IF;
END $$;

-- ER 07 §2.5：order_risk_insight.confidence（置信度 0~1，禁止虚构）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_order_risk_confidence') THEN
    ALTER TABLE order_risk_insight ADD CONSTRAINT ck_order_risk_confidence
      CHECK (confidence BETWEEN 0 AND 1);
  END IF;
END $$;

-- ER 08 §3：approval_request.confidence（置信度 0~1，禁止虚构）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_approval_confidence') THEN
    ALTER TABLE approval_request ADD CONSTRAINT ck_approval_confidence
      CHECK (confidence BETWEEN 0 AND 1);
  END IF;
END $$;

-- ER 03 §2.2：ai_lead.match_pct（产品匹配度 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ai_lead_match_pct') THEN
    ALTER TABLE ai_lead ADD CONSTRAINT ck_ai_lead_match_pct
      CHECK (match_pct BETWEEN 0 AND 100);
  END IF;
END $$;

-- ER 03 §2.3：ai_lead_contact.decision_influence_pct（决策影响力 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ai_lead_contact_influence') THEN
    ALTER TABLE ai_lead_contact ADD CONSTRAINT ck_ai_lead_contact_influence
      CHECK (decision_influence_pct BETWEEN 0 AND 100);
  END IF;
END $$;

-- ER 04 §2.2：contact.decision_influence_pct（决策影响力 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_contact_influence') THEN
    ALTER TABLE contact ADD CONSTRAINT ck_contact_influence
      CHECK (decision_influence_pct BETWEEN 0 AND 100);
  END IF;
END $$;

-- ER 04 §2.1：customer.score（客户评分 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_customer_score') THEN
    ALTER TABLE customer ADD CONSTRAINT ck_customer_score
      CHECK (score BETWEEN 0 AND 100);
  END IF;
END $$;

-- ER 04 §2.4：customer_insight.confidence（置信度 0~1）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_customer_insight_confidence') THEN
    ALTER TABLE customer_insight ADD CONSTRAINT ck_customer_insight_confidence
      CHECK (confidence BETWEEN 0 AND 1);
  END IF;
END $$;

-- ER 05 §2.3：conversation_insight.purchase_probability（采购概率 0~100）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_conv_insight_purchase_prob') THEN
    ALTER TABLE conversation_insight ADD CONSTRAINT ck_conv_insight_purchase_prob
      CHECK (purchase_probability BETWEEN 0 AND 100);
  END IF;
END $$;
