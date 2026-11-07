-- Route history and events are kept for 6 months (they were 3). TimescaleDB drops whole weekly chunks, so in practice data lives
-- between 6 months and 6 months plus a week. Compression of older chunks (0011, 0023) keeps the space small in the meantime.
SELECT remove_retention_policy('positions', if_exists => true);
--> statement-breakpoint
SELECT add_retention_policy('positions', INTERVAL '6 months', if_not_exists => true);
--> statement-breakpoint
SELECT remove_retention_policy('device_events', if_exists => true);
--> statement-breakpoint
SELECT add_retention_policy('device_events', INTERVAL '6 months', if_not_exists => true);
