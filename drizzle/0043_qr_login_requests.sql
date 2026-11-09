CREATE TABLE "qr_login_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"user_agent" varchar(300) DEFAULT '' NOT NULL,
	"device" varchar(120) DEFAULT '' NOT NULL,
	"ip" varchar(45),
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_user_id" uuid,
	"approved_mfa" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qr_login_requests" ADD CONSTRAINT "qr_login_requests_approved_user_id_users_id_fk" FOREIGN KEY ("approved_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qr_login_requests_created_idx" ON "qr_login_requests" USING btree ("created_at");