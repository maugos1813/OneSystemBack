-- Compress position chunks older than 7 days (lossless; typically 80-90% smaller) to keep
-- the Railway volume small as history accumulates. Recent data stays uncompressed so
-- live reads/writes are unaffected.
ALTER TABLE "positions" SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'ts DESC'
);
--> statement-breakpoint
SELECT add_compression_policy('positions', INTERVAL '7 days', if_not_exists => true);
