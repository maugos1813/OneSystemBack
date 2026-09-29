import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TCP_PORT: z.coerce.number().int().positive().default(5027),
  TCP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  HTTP_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  // Comma-separated list of origins allowed to call the API from a browser (the frontend's URL(s)).
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Public base URL of this API, shown as the server in the OpenAPI docs (/docs).
  PUBLIC_API_URL: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Email alerts (Resend). Left unset, the alert scheduler still runs (so idling/geofence
  // state keeps ticking) but silently skips sending — fine for local dev.
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().default("OneSystec Alertas <onboarding@resend.dev>"),
  ALERT_EVAL_INTERVAL_MINUTES: z.coerce.number().positive().default(5),
  // Shared secret for signing short-lived SSO tickets handed to external products
  // (e.g. Gamonal Driver/Farmacy) so a portal user doesn't have to log in twice.
  // Must match the same env var on the receiving app. Left unset, SSO ticket
  // minting fails with a clear error but everything else still works.
  SSO_SHARED_SECRET: z.string().optional(),
  // Radius Velocity (third-party telematics) integration. Left unset, the scheduler
  // still starts but silently skips syncing — same graceful-no-op pattern as RESEND_API_KEY.
  RADIUS_VELOCITY_REFRESH_TOKEN: z.string().optional(),
  RADIUS_VELOCITY_CUSTOMER_ID: z.string().default("22716414390001"),
  // Which org synced vehicles belong to (GamonalTrasporti). Required alongside
  // RADIUS_VELOCITY_REFRESH_TOKEN for the sync to actually run.
  RADIUS_VELOCITY_ORG_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
