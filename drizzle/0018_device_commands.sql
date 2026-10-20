CREATE TYPE "public"."device_command_kind" AS ENUM('immobilize', 'release');--> statement-breakpoint
CREATE TYPE "public"."device_command_status" AS ENUM('pending', 'sent', 'confirmed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "device_command_kind" NOT NULL,
	"command" varchar(100) NOT NULL,
	"status" "device_command_status" DEFAULT 'pending' NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_commands_device_idx" ON "device_commands" USING btree ("device_id","created_at");