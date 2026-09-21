-- Enable the extensions used for time-series and geospatial data.
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint

-- Turn "positions" into a hypertable partitioned by time (one chunk per week by
-- default). Requires "ts" to be part of the primary key, which the schema already does.
SELECT create_hypertable('positions', by_range('ts'), if_not_exists => TRUE);
--> statement-breakpoint

-- Same for device_events, so historical event queries stay fast as the table grows.
SELECT create_hypertable('device_events', by_range('ts'), if_not_exists => TRUE);
--> statement-breakpoint

-- Generated PostGIS point for spatial queries (nearby search, geofencing) without
-- duplicating lat/lng bookkeeping — it's always derived from them.
ALTER TABLE "positions"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "positions_geog_idx" ON "positions" USING GIST ("geog");
--> statement-breakpoint

-- Common access pattern: latest/historical positions for a given device, newest first.
CREATE INDEX IF NOT EXISTS "positions_device_ts_idx" ON "positions" ("device_id", "ts" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "device_events_device_ts_idx" ON "device_events" ("device_id", "ts" DESC);
