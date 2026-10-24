-- Route history is kept for 3 months and then dropped automatically, so the database stops growing without limit.
-- TimescaleDB drops whole chunks (one per week), so there is no row-by-row delete and no cost to free the space:
-- in practice a chunk goes once everything in it is older than 3 months, i.e. data lives between 3 months and
-- 3 months plus a week. Compression of older chunks (0011) keeps working in the meantime.
SELECT add_retention_policy('positions', INTERVAL '3 months', if_not_exists => true);
--> statement-breakpoint
SELECT add_retention_policy('device_events', INTERVAL '3 months', if_not_exists => true);
