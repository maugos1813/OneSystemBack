import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/** The frontend's own origin, for the "ver en la app" link and the logo — reuses
 * CORS_ORIGIN, which in production lists localhost dev origins before the deployed one,
 * so a non-local origin is preferred when there is one. */
const CORS_ORIGINS = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
const APP_URL = CORS_ORIGINS.find((origin) => !/localhost|127\.0\.0\.1/.test(origin)) ?? CORS_ORIGINS[0]!;

export interface AlertEmailItem {
  vehicleName: string;
  message: string;
}

function renderAlertEmailHtml(orgName: string, alerts: AlertEmailItem[]): string {
  const rows = alerts
    .map(
      (a) => `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <p style="margin:0;font-weight:600;color:#0f172a;font-size:14px;">${escapeHtml(a.vehicleName)}</p>
            <p style="margin:4px 0 0;color:#64748b;font-size:13px;">${escapeHtml(a.message)}</p>
          </td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6fb;padding:32px 16px;">
      <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,0.06);">
        <div style="background:linear-gradient(135deg,#38bdf8,#3b82f6,#7c3aed);padding:24px;">
          <table style="border-collapse:collapse;"><tr>
            <td style="padding:0 12px 0 0;vertical-align:middle;">
              <img src="${APP_URL}/logos/onetrack-icon.png" width="40" height="40" alt="" style="display:block;border-radius:10px;" />
            </td>
            <td style="vertical-align:middle;">
              <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;">OneTrack</p>
              <p style="margin:2px 0 0;color:#e0e7ff;font-size:13px;">Alertas de tu flota — ${escapeHtml(orgName)}</p>
            </td>
          </tr></table>
        </div>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <div style="padding:20px 16px;">
          <a href="${APP_URL}/alertas" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;">
            Ver en la app
          </a>
          <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">
            Podés ajustar qué te avisa en Ajustes &gt; Preferencias de alertas.
          </p>
        </div>
      </div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** No-op (logged) if RESEND_API_KEY isn't set — lets the evaluator run in local dev
 * without an email account, and never throws (a delivery failure shouldn't crash the
 * scheduler loop for every other organization). */
export async function sendAlertDigest(to: string, orgName: string, alerts: AlertEmailItem[]): Promise<void> {
  if (alerts.length === 0) return;

  if (!resend) {
    logger.info({ to, orgName, count: alerts.length }, "RESEND_API_KEY not set — skipping alert email");
    return;
  }

  try {
    await resend.emails.send({
      from: env.ALERT_EMAIL_FROM,
      to,
      subject: alerts.length === 1 ? `Alerta: ${alerts[0]!.vehicleName}` : `${alerts.length} alertas nuevas en tu flota`,
      html: renderAlertEmailHtml(orgName, alerts),
    });
  } catch (err) {
    logger.error({ err, to, orgName }, "Failed to send alert email");
  }
}
