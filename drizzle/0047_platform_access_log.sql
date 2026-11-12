CREATE TABLE "platform_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"action" varchar(10) NOT NULL,
	"detail" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_access_log_org_idx" ON "platform_access_log" USING btree ("org_id","created_at");