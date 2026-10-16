CREATE TABLE "sim_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid,
	"operator" varchar(50) DEFAULT 'TIM' NOT NULL,
	"iccid" varchar(32) NOT NULL,
	"phone_number" varchar(20),
	"nmu" varchar(20),
	"pin" varchar(8),
	"puk" varchar(12),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sim_cards_org_iccid_unique" ON "sim_cards" USING btree ("org_id","iccid");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_cards_device_unique" ON "sim_cards" USING btree ("device_id");