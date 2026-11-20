-- Radius Velocity sent the Italian wall clock written as if it were UTC, and it was stored that way: every Velocity position, event and
-- "last seen" is 1 h (winter) or 2 h (summer) ahead of the real moment. This reads each stored value as an Italian wall clock and turns it into
-- the real instant (the same conversion the poller now applies to new reports). Teltonika devices were always right and are not touched.
-- Runs once, at start, before the poller of the new version stores anything.

-- The weekly chunks that were already compressed are opened first (a value moves between chunks when its time changes); the compression
-- policy (0011/0023) packs them again later.
DO $$
DECLARE
  chunk regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    FOR chunk IN
      SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
      FROM timescaledb_information.chunks
      WHERE hypertable_name IN ('positions', 'device_events') AND is_compressed
    LOOP
      PERFORM decompress_chunk(chunk);
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
-- Deleted and inserted again (not UPDATEd): a hypertable does not move a row to another chunk when its time changes, and a shift of 1-2 h
-- can cross the edge of a weekly chunk. An insert always lands in the right one.
WITH moved AS (
  DELETE FROM "positions"
  WHERE "device_id" IN (SELECT "id" FROM "devices" WHERE "source" = 'radius_velocity')
  RETURNING "id", "device_id", "ts", "lat", "lng", "altitude", "angle", "satellites", "speed", "priority", "io_data"
)
INSERT INTO "positions" ("id", "device_id", "ts", "lat", "lng", "altitude", "angle", "satellites", "speed", "priority", "io_data")
SELECT "id", "device_id", ("ts" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome', "lat", "lng", "altitude", "angle", "satellites", "speed", "priority", "io_data"
FROM moved;
--> statement-breakpoint
WITH moved AS (
  DELETE FROM "device_events"
  WHERE "device_id" IN (SELECT "id" FROM "devices" WHERE "source" = 'radius_velocity')
  RETURNING "id", "device_id", "ts", "type", "payload"
)
INSERT INTO "device_events" ("id", "device_id", "ts", "type", "payload")
SELECT "id", "device_id", ("ts" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome', "type", "payload"
FROM moved;
--> statement-breakpoint
UPDATE "devices"
SET "last_seen_at" = ("last_seen_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome'
WHERE "source" = 'radius_velocity' AND "last_seen_at" IS NOT NULL;
