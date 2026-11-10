ALTER TABLE "vehicles" ADD COLUMN "out_of_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "out_of_service_at" timestamp with time zone;