CREATE TABLE "driver_beacons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"beacon_id" varchar(100) NOT NULL,
	"driver_name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_beacons_org_beacon_unique" UNIQUE("org_id","beacon_id")
);
--> statement-breakpoint
ALTER TABLE "driver_beacons" ADD CONSTRAINT "driver_beacons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;