CREATE TABLE "vehicle_daily_km" (
	"vehicle_id" uuid NOT NULL,
	"day" date NOT NULL,
	"km" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_daily_km_vehicle_id_day_pk" PRIMARY KEY("vehicle_id","day")
);
--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD COLUMN "km_adjust" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle_daily_km" ADD CONSTRAINT "vehicle_daily_km_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;