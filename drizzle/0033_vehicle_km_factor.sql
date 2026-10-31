ALTER TABLE "vehicles" ADD COLUMN "km_factor" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "km_factor_at" timestamp with time zone;