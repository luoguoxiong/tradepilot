CREATE TYPE "public"."activity_type" AS ENUM('stage_change', 'owner_change', 'email', 'quote', 'follow_up', 'note', 'ai_action');--> statement-breakpoint
CREATE TYPE "public"."ai_employee_role" AS ENUM('lead_hunter', 'customer_researcher', 'sales', 'follow_up', 'merchandiser', 'manager');--> statement-breakpoint
CREATE TYPE "public"."ai_intent" AS ENUM('rfq', 'price_compare', 'logistics', 'sample', 'other');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'auto_approved', 'approved', 'edited_approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."approval_type" AS ENUM('quote', 'email_send', 'contract', 'order_change', 'bulk_marketing', 'customer_delete');--> statement-breakpoint
CREATE TYPE "public"."auto_send_policy" AS ENUM('manual_review', 'auto_send', 'value_based');--> statement-breakpoint
CREATE TYPE "public"."conversation_priority" AS ENUM('high', 'normal', 'pending');--> statement-breakpoint
CREATE TYPE "public"."customer_stage" AS ENUM('new_lead', 'contacted', 'negotiation', 'cold');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('brand', 'distributor', 'factory', 'other');--> statement-breakpoint
CREATE TYPE "public"."discovery_type" AS ENUM('opportunity', 'risk');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('working', 'waiting_approval', 'scheduled', 'risk', 'failed', 'idle');--> statement-breakpoint
CREATE TYPE "public"."fexec_status" AS ENUM('sent', 'waiting_approval', 'approved', 'rejected', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."follow_up_stage" AS ENUM('follow_up_1', 'follow_up_2', 'follow_up_3', 'quote_followup');--> statement-breakpoint
CREATE TYPE "public"."follow_up_task_status" AS ENUM('ready', 'scheduled', 'waiting_approval', 'completed', 'paused');--> statement-breakpoint
CREATE TYPE "public"."index_status" AS ENUM('indexed', 'indexing', 'failed');--> statement-breakpoint
CREATE TYPE "public"."insight_type" AS ENUM('purchase_probability', 'reactivation', 'product_match', 'pricing', 'order_risk');--> statement-breakpoint
CREATE TYPE "public"."knowledge_category" AS ENUM('product', 'company', 'sales', 'customer', 'faq', 'process', 'other');--> statement-breakpoint
CREATE TYPE "public"."knowledge_search_scene" AS ENUM('lead_match', 'sales_reply', 'follow_up', 'pricing_basis', 'business_analysis');--> statement-breakpoint
CREATE TYPE "public"."lead_value" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('gmail', 'outlook', 'smtp_imap');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('connected', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'disabled', 'invited');--> statement-breakpoint
CREATE TYPE "public"."msg_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."msg_status" AS ENUM('draft', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operator_type" AS ENUM('ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."order_risk" AS ENUM('normal', 'at_risk');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'in_production', 'ready_to_ship', 'completed');--> statement-breakpoint
CREATE TYPE "public"."product_doc_type" AS ENUM('catalog', 'certification', 'test_report', 'other');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'waiting_approval', 'sent', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."report_period" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."sender_type" AS ENUM('ai', 'user', 'contact');--> statement-breakpoint
CREATE TYPE "public"."task_log_type" AS ENUM('search', 'found', 'crawl', 'match', 'contact', 'lookup', 'error');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('running', 'waiting_approval', 'scheduled', 'paused', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('lead_hunting', 'email_reply', 'follow_up', 'order_monitor', 'business_analysis', 'knowledge_index', 'product_analysis');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'manager', 'sales');--> statement-breakpoint
CREATE TABLE "ai_model_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scene" text NOT NULL,
	"model" text NOT NULL,
	"temperature" numeric(3, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer NOT NULL,
	"budget_limit" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ai_model_org_scene" UNIQUE("org_id","scene")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"sync_direction" text NOT NULL,
	"mapping" jsonb,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text,
	"provider" "mailbox_provider" NOT NULL,
	"account" text NOT NULL,
	"imap" jsonb,
	"smtp" jsonb,
	"sync_scope" jsonb NOT NULL,
	"status" "mailbox_status" NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channels" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notification_org" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"country" text,
	"timezone" text,
	"default_language" text,
	"default_currency" char(3),
	"industry" text,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"send_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_rule_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_categories" text[] NOT NULL,
	"cost_items" text[] NOT NULL,
	"profit_floor_pct" numeric(5, 2) NOT NULL,
	"discount_ladder" smallint[] NOT NULL,
	"default_incoterms" text NOT NULL,
	"default_currency" char(3) NOT NULL,
	"exchange_rate_source" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_rule_org" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role" "user_role" NOT NULL,
	"permissions" jsonb NOT NULL,
	"approval_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_role_perm_org_role" UNIQUE("org_id","role")
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "member_status" DEFAULT 'invited' NOT NULL,
	"invited_by" text,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_org_email" UNIQUE("org_id","email")
);
--> statement-breakpoint
CREATE TABLE "webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_employee" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role" "ai_employee_role" NOT NULL,
	"name" text NOT NULL,
	"avatar" text,
	"status" "employee_status" DEFAULT 'idle' NOT NULL,
	"status_detail" text,
	"goal" text NOT NULL,
	"sop_template_id" text,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"tools" text[] DEFAULT '{}' NOT NULL,
	"knowledge_scope" text[] DEFAULT '{}' NOT NULL,
	"memory_config" jsonb,
	"workflow_id" text,
	"permissions" jsonb NOT NULL,
	"approval_policy" jsonb NOT NULL,
	"kpi_config" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_task" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"type" "task_type" NOT NULL,
	"title" text NOT NULL,
	"status" "task_status" DEFAULT 'running' NOT NULL,
	"progress_pct" smallint DEFAULT 0 NOT NULL,
	"current_step" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb,
	"error" text,
	"linked_approval_id" text,
	"retry_of" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_task_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" "task_log_type" NOT NULL,
	"content" text NOT NULL,
	"lead_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_task_step" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"name" text NOT NULL,
	"status" "task_status" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_task_step_task_seq" UNIQUE("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "llm_call" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text,
	"employee_id" text,
	"node" text NOT NULL,
	"scene" text,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sop_template" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role" "ai_employee_role" NOT NULL,
	"name" text NOT NULL,
	"content" jsonb NOT NULL,
	"is_preset" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_lead" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text,
	"company_name" text NOT NULL,
	"country" text NOT NULL,
	"industry" text,
	"website" text,
	"company_domain" text,
	"match_pct" smallint NOT NULL,
	"score_level" "lead_value" NOT NULL,
	"insight" jsonb NOT NULL,
	"overview" jsonb,
	"analyzed_at" timestamp with time zone,
	"in_crm" boolean DEFAULT false NOT NULL,
	"converted_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_lead_contact" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"decision_influence_pct" smallint,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"email" text,
	"phone" text,
	"decision_influence_pct" smallint,
	"decision_influence_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_name" text NOT NULL,
	"country" text NOT NULL,
	"website" text,
	"industry" text,
	"industry_tags" text[],
	"customer_type" "customer_type",
	"stage" "customer_stage" DEFAULT 'new_lead' NOT NULL,
	"is_formal" boolean DEFAULT false NOT NULL,
	"score" smallint,
	"owner_id" text NOT NULL,
	"source_lead_id" text,
	"next_action" jsonb,
	"remark" text,
	"delete_locked" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"type" "activity_type" NOT NULL,
	"summary" text NOT NULL,
	"operator_type" "operator_type" NOT NULL,
	"operator_id" text,
	"operator_name" text,
	"ref_type" text,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_insight" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"insight_type" "insight_type" NOT NULL,
	"value" numeric,
	"confidence" numeric(4, 3),
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb,
	"next_action" jsonb,
	"task_id" text,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_customer_insight_type" UNIQUE("customer_id","insight_type")
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"contact_id" text,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text,
	"priority" "conversation_priority" DEFAULT 'pending' NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"mailbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_insight" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"intent" "ai_intent" NOT NULL,
	"purchase_probability" smallint,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_insight" UNIQUE("conversation_id")
);
--> statement-breakpoint
CREATE TABLE "follow_up_execution" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"follow_up_task_id" text NOT NULL,
	"strategy_step_id" text,
	"step_title" text NOT NULL,
	"status" "fexec_status" NOT NULL,
	"content" text,
	"message_id" text,
	"approval_id" text,
	"approved_by" text,
	"skip_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_strategy" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"target_scope" jsonb NOT NULL,
	"auto_send_policy" "auto_send_policy" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_strategy_step" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"day_offset" smallint NOT NULL,
	"title" text NOT NULL,
	"template_id" text,
	"content" text,
	"channel" text DEFAULT 'email' NOT NULL,
	"is_breakup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_fstep_strategy_seq" UNIQUE("strategy_id","seq"),
	CONSTRAINT "uq_fstep_strategy_day" UNIQUE("strategy_id","day_offset")
);
--> statement-breakpoint
CREATE TABLE "follow_up_task" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"current_stage" "follow_up_stage" DEFAULT 'follow_up_1' NOT NULL,
	"next_run_at" timestamp with time zone,
	"status" "follow_up_task_status" DEFAULT 'ready' NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ftask_org_customer_strategy" UNIQUE("org_id","customer_id","strategy_id")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"direction" "msg_direction" NOT NULL,
	"sender_type" "sender_type" NOT NULL,
	"sender_name" text NOT NULL,
	"mailbox_id" text,
	"content" text NOT NULL,
	"language" text,
	"status" "msg_status" DEFAULT 'draft' NOT NULL,
	"citations" jsonb,
	"based_on_message_id" text,
	"edited_diff" jsonb,
	"external_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunk" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"document_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1536),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_kchunk_doc_index" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "knowledge_document" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"file_name" text NOT NULL,
	"category" "knowledge_category" NOT NULL,
	"file_type" text,
	"size" bigint,
	"file_url" text NOT NULL,
	"status" "index_status" DEFAULT 'indexing' NOT NULL,
	"error" text,
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"product_id" text,
	"uploaded_by" text,
	"indexed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"image_url" text,
	"moq" integer NOT NULL,
	"moq_unit" text DEFAULT 'pcs' NOT NULL,
	"lead_time_days" smallint NOT NULL,
	"material" text,
	"description" text,
	"cost_price" numeric(18, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"suggested_price" numeric(18, 2),
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_product_org_sku" UNIQUE("org_id","sku")
);
--> statement-breakpoint
CREATE TABLE "product_document" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"size" bigint,
	"doc_type" "product_doc_type" NOT NULL,
	"indexed" boolean DEFAULT false NOT NULL,
	"knowledge_doc_id" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_id" text NOT NULL,
	"advantages" text[],
	"faqs" jsonb,
	"scenarios" text[],
	"sales_scripts" text[],
	"status" text DEFAULT 'draft' NOT NULL,
	"citations" jsonb,
	"task_id" text,
	"generated_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_product_knowledge_product" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "product_price_tier" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"min_qty" integer NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	CONSTRAINT "uq_product_tier_min_qty" UNIQUE("product_id","min_qty")
);
--> statement-breakpoint
CREATE TABLE "product_spec" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	CONSTRAINT "uq_product_spec_seq" UNIQUE("product_id","seq")
);
--> statement-breakpoint
CREATE TABLE "order_progress_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"production_pct" smallint NOT NULL,
	"note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_risk_insight" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"delay_days" smallint NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"status" text DEFAULT 'active' NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"contact_id" text,
	"currency" char(3) NOT NULL,
	"incoterms" text NOT NULL,
	"valid_until" date NOT NULL,
	"exchange_rate" numeric(18, 8) NOT NULL,
	"exchange_rate_date" date NOT NULL,
	"exchange_rate_source" text NOT NULL,
	"payment_terms" text NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"ai_pricing" jsonb,
	"profit_margin_pct" numeric(5, 2),
	"approval_id" text,
	"owner_id" text NOT NULL,
	"sent_at" timestamp with time zone,
	"won_at" timestamp with time zone,
	"lost_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_quote_org_no" UNIQUE("org_id","quote_no")
);
--> statement-breakpoint
CREATE TABLE "quotation_item" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quotation_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"cost_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "uq_quote_item_seq" UNIQUE("quotation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sales_order" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"order_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"contact_id" text,
	"quotation_id" text,
	"delivery_date" date NOT NULL,
	"payment_terms" text,
	"amount" numeric(18, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"risk" "order_risk" DEFAULT 'normal' NOT NULL,
	"progress_po_confirmed" boolean DEFAULT false NOT NULL,
	"progress_payment" boolean DEFAULT false NOT NULL,
	"production_pct" smallint DEFAULT 0 NOT NULL,
	"progress_shipping" boolean DEFAULT false NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_order_org_no" UNIQUE("org_id","order_no")
);
--> statement-breakpoint
CREATE TABLE "sales_order_item" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"seq" smallint NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"cost_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "uq_order_item_seq" UNIQUE("sales_order_id","seq")
);
--> statement-breakpoint
CREATE TABLE "ai_discovery" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "discovery_type" NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestion" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"executed_ref" jsonb,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_daily_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"stat_date" date NOT NULL,
	"country" text DEFAULT 'ALL' NOT NULL,
	"employee_id" text DEFAULT 'ALL' NOT NULL,
	"new_customers" integer DEFAULT 0 NOT NULL,
	"new_inquiries" integer DEFAULT 0 NOT NULL,
	"new_quotes" integer DEFAULT 0 NOT NULL,
	"found_customers" integer DEFAULT 0 NOT NULL,
	"replied_emails" integer DEFAULT 0 NOT NULL,
	"promoted_inquiries" integer DEFAULT 0 NOT NULL,
	"saved_hours" numeric(10, 1) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_analytics_daily" UNIQUE("org_id","stat_date","country","employee_id")
);
--> statement-breakpoint
CREATE TABLE "approval_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"action" "approval_status" NOT NULL,
	"approver_id" text NOT NULL,
	"approver_name" text NOT NULL,
	"edited_diff" jsonb,
	"reject_reason" text,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"approval_type" "approval_type" NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"title" text NOT NULL,
	"biz_type" text NOT NULL,
	"biz_id" text NOT NULL,
	"context" jsonb NOT NULL,
	"ai_proposal" jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by_employee_id" text,
	"requested_by_user_id" text,
	"linked_task_id" text,
	"expires_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_report" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period" "report_period" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "report_status" DEFAULT 'generating' NOT NULL,
	"content" text,
	"citations" jsonb,
	"task_id" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_model_setting" ADD CONSTRAINT "ai_model_setting_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_integration" ADD CONSTRAINT "crm_integration_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_owner_user_id_user_account_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rule_setting" ADD CONSTRAINT "pricing_rule_setting_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rule_setting" ADD CONSTRAINT "pricing_rule_setting_updated_by_user_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_updated_by_user_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook" ADD CONSTRAINT "webhook_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_sop_template_id_sop_template_id_fk" FOREIGN KEY ("sop_template_id") REFERENCES "public"."sop_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee" ADD CONSTRAINT "ai_employee_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_employee_id_ai_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."ai_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_retry_of_ai_task_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_log" ADD CONSTRAINT "ai_task_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_log" ADD CONSTRAINT "ai_task_log_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_step" ADD CONSTRAINT "ai_task_step_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_step" ADD CONSTRAINT "ai_task_step_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_employee_id_ai_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."ai_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_template" ADD CONSTRAINT "sop_template_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_lead" ADD CONSTRAINT "ai_lead_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_lead" ADD CONSTRAINT "ai_lead_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_lead_contact" ADD CONSTRAINT "ai_lead_contact_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_lead_contact" ADD CONSTRAINT "ai_lead_contact_lead_id_ai_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."ai_lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_activity" ADD CONSTRAINT "customer_activity_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_activity" ADD CONSTRAINT "customer_activity_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insight" ADD CONSTRAINT "customer_insight_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insight" ADD CONSTRAINT "customer_insight_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_insight" ADD CONSTRAINT "customer_insight_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_insight" ADD CONSTRAINT "conversation_insight_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_insight" ADD CONSTRAINT "conversation_insight_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_execution" ADD CONSTRAINT "follow_up_execution_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_execution" ADD CONSTRAINT "follow_up_execution_follow_up_task_id_follow_up_task_id_fk" FOREIGN KEY ("follow_up_task_id") REFERENCES "public"."follow_up_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_execution" ADD CONSTRAINT "follow_up_execution_strategy_step_id_follow_up_strategy_step_id_fk" FOREIGN KEY ("strategy_step_id") REFERENCES "public"."follow_up_strategy_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_execution" ADD CONSTRAINT "follow_up_execution_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_execution" ADD CONSTRAINT "follow_up_execution_approved_by_user_account_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_strategy" ADD CONSTRAINT "follow_up_strategy_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_strategy" ADD CONSTRAINT "follow_up_strategy_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_strategy_step" ADD CONSTRAINT "follow_up_strategy_step_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_strategy_step" ADD CONSTRAINT "follow_up_strategy_step_strategy_id_follow_up_strategy_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."follow_up_strategy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_strategy_step" ADD CONSTRAINT "follow_up_strategy_step_template_id_knowledge_document_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."knowledge_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD CONSTRAINT "follow_up_task_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD CONSTRAINT "follow_up_task_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_task" ADD CONSTRAINT "follow_up_task_strategy_id_follow_up_strategy_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."follow_up_strategy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_based_on_message_id_message_id_fk" FOREIGN KEY ("based_on_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_document_id_knowledge_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_uploaded_by_user_account_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_deleted_by_user_account_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_document" ADD CONSTRAINT "product_document_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_document" ADD CONSTRAINT "product_document_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_document" ADD CONSTRAINT "product_document_knowledge_doc_id_knowledge_document_id_fk" FOREIGN KEY ("knowledge_doc_id") REFERENCES "public"."knowledge_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_document" ADD CONSTRAINT "product_document_uploaded_by_user_account_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_knowledge" ADD CONSTRAINT "product_knowledge_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_knowledge" ADD CONSTRAINT "product_knowledge_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_knowledge" ADD CONSTRAINT "product_knowledge_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_knowledge" ADD CONSTRAINT "product_knowledge_confirmed_by_user_account_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_tier" ADD CONSTRAINT "product_price_tier_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_spec" ADD CONSTRAINT "product_spec_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_progress_log" ADD CONSTRAINT "order_progress_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_progress_log" ADD CONSTRAINT "order_progress_log_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_progress_log" ADD CONSTRAINT "order_progress_log_updated_by_user_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_risk_insight" ADD CONSTRAINT "order_risk_insight_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_risk_insight" ADD CONSTRAINT "order_risk_insight_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_item" ADD CONSTRAINT "quotation_item_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_item" ADD CONSTRAINT "quotation_item_quotation_id_quotation_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_item" ADD CONSTRAINT "quotation_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_quotation_id_quotation_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_item" ADD CONSTRAINT "sales_order_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_discovery" ADD CONSTRAINT "ai_discovery_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily_summary" ADD CONSTRAINT "analytics_daily_summary_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_log" ADD CONSTRAINT "approval_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_log" ADD CONSTRAINT "approval_log_approval_id_approval_request_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_log" ADD CONSTRAINT "approval_log_approver_id_user_account_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_requested_by_employee_id_ai_employee_id_fk" FOREIGN KEY ("requested_by_employee_id") REFERENCES "public"."ai_employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_requested_by_user_id_user_account_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decided_by_user_account_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_report" ADD CONSTRAINT "business_report_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_report" ADD CONSTRAINT "business_report_task_id_ai_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_key_hash" ON "api_key" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mailbox_org_account" ON "mailbox" USING btree ("org_id",lower("account"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_global_email" ON "user_account" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_user_org_status" ON "user_account" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_user_invited_by" ON "user_account" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX "idx_ai_employee_org_role" ON "ai_employee" USING btree ("org_id","role","status");--> statement-breakpoint
CREATE INDEX "idx_ai_task_org_status" ON "ai_task" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ai_task_org_employee" ON "ai_task" USING btree ("org_id","employee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ai_task_org_type" ON "ai_task" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_ai_task_log_task" ON "ai_task_log" USING btree ("task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_llm_call_org_time" ON "llm_call" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ai_lead_org_level" ON "ai_lead" USING btree ("org_id","score_level") WHERE in_crm = false;--> statement-breakpoint
CREATE INDEX "idx_ai_lead_org_task" ON "ai_lead" USING btree ("org_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_ai_lead_org_country" ON "ai_lead" USING btree ("org_id","country");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_lead_org_domain" ON "ai_lead" USING btree ("org_id","company_domain") WHERE "ai_lead"."company_domain" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ai_lead_contact_lead" ON "ai_lead_contact" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contact_org_email" ON "contact" USING btree ("org_id",lower("email")) WHERE "contact"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_contact_customer" ON "contact" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_customer_org_name" ON "customer" USING btree ("org_id",lower("company_name")) WHERE "customer"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_customer_org_stage" ON "customer" USING btree ("org_id","stage","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_customer_org_owner" ON "customer" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "idx_customer_org_score" ON "customer" USING btree ("org_id","score" DESC NULLS LAST) WHERE "customer"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_customer_org_country" ON "customer" USING btree ("org_id","country");--> statement-breakpoint
CREATE INDEX "idx_activity_customer" ON "customer_activity" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_activity_org" ON "customer_activity" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_activity_type" ON "customer_activity" USING btree ("org_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_customer_insight_generated" ON "customer_insight" USING btree ("customer_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conversation_org_recent" ON "conversation" USING btree ("org_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conversation_org_priority" ON "conversation" USING btree ("org_id","priority");--> statement-breakpoint
CREATE INDEX "idx_conversation_customer" ON "conversation" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_fexec_task" ON "follow_up_execution" USING btree ("follow_up_task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_fexec_status" ON "follow_up_execution" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_ftask_schedule" ON "follow_up_task" USING btree ("org_id","status","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_message_conversation" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_message_external" ON "message" USING btree ("mailbox_id","external_message_id") WHERE "message"."external_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_message_draft" ON "message" USING btree ("org_id","status") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "idx_kchunk_doc" ON "knowledge_chunk" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_kdoc_org_category" ON "knowledge_document" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_kdoc_org_status" ON "knowledge_document" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_product_org_status" ON "product" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_product_org_category" ON "product" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_pdoc_product" ON "product_document" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_oplog_order" ON "order_progress_log" USING btree ("sales_order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_orisk_order" ON "order_risk_insight" USING btree ("sales_order_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_quote_org_status" ON "quotation" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_quote_customer" ON "quotation" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_quote_owner" ON "quotation" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "idx_order_org_status" ON "sales_order" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_order_org_risk" ON "sales_order" USING btree ("org_id","risk") WHERE risk = 'at_risk';--> statement-breakpoint
CREATE INDEX "idx_order_customer" ON "sales_order" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_order_delivery" ON "sales_order" USING btree ("org_id","delivery_date");--> statement-breakpoint
CREATE INDEX "idx_discovery_org" ON "ai_discovery" USING btree ("org_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_alog_approval" ON "approval_log" USING btree ("approval_id","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_approval_org_status" ON "approval_request" USING btree ("org_id","status","approval_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_approval_biz" ON "approval_request" USING btree ("biz_type","biz_id");--> statement-breakpoint
CREATE INDEX "idx_approval_pending" ON "approval_request" USING btree ("org_id","expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_report_org" ON "business_report" USING btree ("org_id","period","created_at" DESC NULLS LAST);