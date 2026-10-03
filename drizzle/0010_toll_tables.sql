CREATE TABLE "toll_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"plaza_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "toll_plazas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"osm_key" varchar(30) NOT NULL,
	"name" varchar(150) NOT NULL,
	"operator" varchar(150),
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	CONSTRAINT "toll_plazas_osm_key_unique" UNIQUE("osm_key")
);
--> statement-breakpoint
ALTER TABLE "toll_passages" ADD CONSTRAINT "toll_passages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toll_passages" ADD CONSTRAINT "toll_passages_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toll_passages" ADD CONSTRAINT "toll_passages_plaza_id_toll_plazas_id_fk" FOREIGN KEY ("plaza_id") REFERENCES "public"."toll_plazas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toll_passages_org_ts_idx" ON "toll_passages" USING btree ("org_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "toll_passages_vehicle_plaza_ts_idx" ON "toll_passages" USING btree ("vehicle_id","plaza_id","ts" DESC NULLS LAST);