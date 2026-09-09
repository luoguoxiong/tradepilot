ALTER TABLE "ai_task" ALTER COLUMN "status" SET DEFAULT 'scheduled';--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "oauth" jsonb;