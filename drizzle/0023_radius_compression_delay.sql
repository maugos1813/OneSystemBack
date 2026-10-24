-- Radius Velocity route history is pruned after 7 days by the app (pruneRadiusHistory). Compressed rows are costly to
-- delete one by one, so compression now starts after 10 days: everything the prune touches is still uncompressed.
SELECT remove_compression_policy('positions', if_exists => true);
--> statement-breakpoint
SELECT add_compression_policy('positions', INTERVAL '10 days', if_not_exists => true);
