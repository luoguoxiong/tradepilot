CREATE TYPE "public"."ai_model_type" AS ENUM('llm', 'embedding');--> statement-breakpoint
-- NOTE: msg_status 'waiting_approval' 由 manual/0007_manual_msg_status_waiting_approval.sql 幂等补齐，
-- 此处不重复 ALTER（否则存量库重放报 enum label already exists）。
CREATE TABLE "ai_model" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "ai_model_type" NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key_enc" text,
	"dimensions" integer,
	"temperature" numeric(3, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ai_model_org_type_name" UNIQUE("org_id","type","name")
);
--> statement-breakpoint
ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_model_org_type" ON "ai_model" USING btree ("org_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_model_org_type_selected" ON "ai_model" USING btree ("org_id","type") WHERE "ai_model"."is_selected";