CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"payload" jsonb,
	"ref_type" text,
	"ref_id" text,
	"email_sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_org_recent" ON "notification" USING btree ("org_id","created_at" DESC NULLS LAST);