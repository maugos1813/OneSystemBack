import { logger } from "../config/logger.js";
import { addDays, dailyKmRowCount, recomputeDailyKm, romeDay } from "../services/dailyKm.service.js";

const TICK_MS = 30 * 60_000;
/** Each tick re-adds the last few days, so a report that arrived late (a tracker that was offline) still counts. */
const TICK_DAYS = 3;
/** On boot: a short catch-up, or everything the positions still hold when there is nothing stored yet. */
const BOOT_DAYS = 10;
const FIRST_FILL_DAYS = 100;

async function run(days: number): Promise<void> {
  const written = await recomputeDailyKm(addDays(romeDay(new Date()), -days));
  logger.info({ days, written }, "Daily km recomputed");
}

/** Keeps vehicle_daily_km up to date: the kilometres that maintenance plans are counted from. */
export function startDailyKmScheduler(): void {
  const safely = (days: number) => run(days).catch((err) => logger.error({ err }, "Daily km recompute failed"));

  setInterval(() => void safely(TICK_DAYS), TICK_MS);
  logger.info({ everyMinutes: TICK_MS / 60_000 }, "Daily km scheduler started");

  // Right after boot, once positions are queryable.
  setTimeout(() => {
    dailyKmRowCount()
      .then((rows) => safely(rows === 0 ? FIRST_FILL_DAYS : BOOT_DAYS))
      .catch((err) => logger.error({ err }, "Daily km first run failed"));
  }, 20_000);
}
