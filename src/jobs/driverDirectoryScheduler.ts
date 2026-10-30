import { logger } from "../config/logger.js";
import { driverDirectoryRowCount, isDriverDirectoryConfigured, syncSafely } from "../services/driverDirectory.service.js";

const TICK_MS = 30 * 60_000;
/** Each tick re-reads the last few days, so a service edited or cancelled in the Driver is corrected here too. */
const TICK_DAYS = 3;
const BOOT_DAYS = 10;
/** The most the Driver lets one request ask for is 93 days. */
const FIRST_FILL_DAYS = 90;

/** Keeps a copy of the Gamonal Driver's drivers and services: who had which vehicle, and the phone to call. */
export function startDriverDirectoryScheduler(): void {
  if (!isDriverDirectoryConfigured()) {
    logger.info("Driver directory sync skipped: DRIVER_INTEGRATION_KEY or the organization is not set");
    return;
  }
  setInterval(() => void syncSafely(TICK_DAYS), TICK_MS);
  logger.info({ everyMinutes: TICK_MS / 60_000 }, "Driver directory scheduler started");

  setTimeout(() => {
    driverDirectoryRowCount()
      .then((rows) => syncSafely(rows === 0 ? FIRST_FILL_DAYS : BOOT_DAYS))
      .catch((err) => logger.error({ err }, "Driver directory first run failed"));
  }, 30_000);
}
