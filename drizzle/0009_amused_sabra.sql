CREATE TYPE "public"."geofence_type" AS ENUM('circle', 'polygon');--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "lat" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "lng" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "radius_meters" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "type" "geofence_type" DEFAULT 'circle' NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN "path" jsonb;