ALTER TABLE "vehicles" ADD COLUMN "brand" varchar(50);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "model" varchar(50);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "vin" varchar(30);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "fuel_type" varchar(20);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "color" varchar(30);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "odometer_mode" varchar(10) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "odometer_base_km" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "odometer_base_at" timestamp with time zone;