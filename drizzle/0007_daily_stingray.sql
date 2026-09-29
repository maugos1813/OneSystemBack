CREATE TYPE "public"."device_source" AS ENUM('teltonika', 'radius_velocity');--> statement-breakpoint
ALTER TABLE "positions" ALTER COLUMN "satellites" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "source" "device_source" DEFAULT 'teltonika' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "fleet_group" varchar(50);