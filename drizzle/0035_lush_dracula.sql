CREATE TABLE "platform_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(160) NOT NULL,
	"type" varchar(40) NOT NULL,
	"severity" varchar(10) NOT NULL,
	"org_id" uuid,
	"device_id" uuid,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"digested_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "platform_alerts" ADD CONSTRAINT "platform_alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_alerts" ADD CONSTRAINT "platform_alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_alerts_open_key" ON "platform_alerts" USING btree ("key") WHERE "platform_alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "platform_alerts_key_idx" ON "platform_alerts" USING btree ("key");