ALTER TYPE "public"."device_command_kind" ADD VALUE 'green_driving';--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "green_driving_since" timestamp with time zone;