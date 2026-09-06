ALTER TABLE "org" ALTER COLUMN "onboarding" SET DEFAULT '{"currentStep":1,"steps":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "org" ALTER COLUMN "send_rules" SET DEFAULT '{"sendWindow":{"start":"09:00","end":"18:00"},"minTouchIntervalDays":3}'::jsonb;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ck_task_progress" CHECK ("ai_task"."progress_pct" BETWEEN 0 AND 100);