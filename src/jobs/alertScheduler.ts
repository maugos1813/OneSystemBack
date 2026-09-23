import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { evaluateAllOrganizations } from "../services/alertEvaluation.service.js";

/** Runs the alert evaluator on a fixed interval — this process is already long-running
 * (it hosts the TCP ingestion server too), so a plain setInterval works fine; no need
 * for an external cron given there's no serverless cold-start concern here. */
export function startAlertScheduler(): void {
  const intervalMs = env.ALERT_EVAL_INTERVAL_MINUTES * 60_000;

  const tick = () => {
    evaluateAllOrganizations().catch((err) => {
      logger.error({ err }, "Alert evaluation tick failed");
    });
  };

  setInterval(tick, intervalMs);
  logger.info({ intervalMinutes: env.ALERT_EVAL_INTERVAL_MINUTES }, "Alert scheduler started");

  // Give positions a moment to be queryable after boot before the first pass.
  setTimeout(tick, 15_000);
}
