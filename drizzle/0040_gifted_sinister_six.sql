CREATE TABLE "vehicle_device_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"from_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"to_ts" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vehicle_device_assignments" ADD CONSTRAINT "vehicle_device_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_device_assignments" ADD CONSTRAINT "vehicle_device_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicle_device_assignments_vehicle_idx" ON "vehicle_device_assignments" USING btree ("vehicle_id","from_ts");--> statement-breakpoint
CREATE INDEX "vehicle_device_assignments_device_idx" ON "vehicle_device_assignments" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_device_assignments_open_vehicle" ON "vehicle_device_assignments" USING btree ("vehicle_id") WHERE "vehicle_device_assignments"."to_ts" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_device_assignments_open_device" ON "vehicle_device_assignments" USING btree ("device_id") WHERE "vehicle_device_assignments"."to_ts" is null;--> statement-breakpoint
-- The vehicles that already carry a device keep ALL of that device's history, as before: their assignment starts at the epoch. (A device
-- that two vehicles point at goes to the newest vehicle, so the one-open-assignment-per-device rule holds.)
INSERT INTO "vehicle_device_assignments" ("vehicle_id", "device_id", "from_ts")
SELECT DISTINCT ON ("device_id") "id", "device_id", 'epoch'::timestamptz
FROM "vehicles"
WHERE "device_id" IS NOT NULL
ORDER BY "device_id", "created_at" DESC;
--> statement-breakpoint
-- From now on every change of a vehicle's device is recorded, whoever makes it (the app, the Radius Velocity sync, a manual fix).
CREATE FUNCTION "vehicle_device_assignment_sync"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."device_id" IS NOT DISTINCT FROM OLD."device_id" THEN
    RETURN NEW;
  END IF;
  -- The vehicle stops carrying whatever it carried.
  UPDATE "vehicle_device_assignments" SET "to_ts" = now() WHERE "vehicle_id" = NEW."id" AND "to_ts" IS NULL;
  IF NEW."device_id" IS NOT NULL THEN
    -- The device leaves whichever other vehicle had it, and this one starts carrying it.
    UPDATE "vehicle_device_assignments" SET "to_ts" = now() WHERE "device_id" = NEW."device_id" AND "to_ts" IS NULL;
    INSERT INTO "vehicle_device_assignments" ("vehicle_id", "device_id", "from_ts") VALUES (NEW."id", NEW."device_id", now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "vehicle_device_assignment_sync"
AFTER INSERT OR UPDATE OF "device_id" ON "vehicles"
FOR EACH ROW EXECUTE FUNCTION "vehicle_device_assignment_sync"();
