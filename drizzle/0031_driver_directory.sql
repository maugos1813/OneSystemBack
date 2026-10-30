CREATE TABLE "driver_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"name" varchar(150) NOT NULL,
	"phone" varchar(40),
	"active" boolean DEFAULT true NOT NULL,
	"habitual_plate" varchar(20),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_people_org_external_unique" UNIQUE("org_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "driver_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"driver_external_id" varchar(64) NOT NULL,
	"plate" varchar(20) NOT NULL,
	"final_plate" varchar(20),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"declared" boolean DEFAULT false NOT NULL,
	"status" varchar(20) NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_usages_org_external_unique" UNIQUE("org_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "driver_people" ADD CONSTRAINT "driver_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_usages" ADD CONSTRAINT "driver_usages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_usages_plate_idx" ON "driver_usages" USING btree ("org_id","plate","starts_at");