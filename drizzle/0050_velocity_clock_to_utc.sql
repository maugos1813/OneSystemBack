-- Intentionally empty. This migration first tried to correct the stored Radius Velocity history (times 1-2 h ahead of the real moment), but
-- decompress_chunk failed on a foreign key (old rows of a device that no longer exists) and stopped the server at start. The history is
-- corrected once, by hand, against the live database; the conversion of NEW Velocity reports lives in services/fleetTime.ts.
SELECT 1;
