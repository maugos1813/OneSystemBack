import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { syncRadiusVelocity } from "../services/radiusVelocity.service.js";

const POLL_INTERVAL_MS = 30_000;

/** Polls the Radius Velocity API on a fixed interval, mirroring alertScheduler.ts's
 * plain setInterval approach. No-ops (never starts a timer) when unconfigured. */
export function startRadiusVelocityScheduler(): void {
  if (!env.RADIUS_VELOCITY_REFRESH_TOKEN || !env.RADIUS_VELOCITY_ORG_ID) {
    logger.info("Radius Velocity scheduler not started (RADIUS_VELOCITY_REFRESH_TOKEN/ORG_ID not set)");
    return;
  }

  const tick = () => {
    syncRadiusVelocity().catch((err) => {
      logger.error({ err }, "Radius Velocity sync tick failed");
    });
  };

  setInterval(tick, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Radius Velocity scheduler started");
  tick();
}
