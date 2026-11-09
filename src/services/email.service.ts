import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DEFAULT_LANGUAGE, pick, type Language, type Localized } from "./i18n.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/** The frontend's own origin, for the "ver en la app" link and the logo — reuses
 * CORS_ORIGIN, which in production lists localhost dev origins before the deployed one,
 * so a non-local origin is preferred when there is one. */
const CORS_ORIGINS = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
const APP_URL = CORS_ORIGINS.find((origin) => !/localhost|127\.0\.0\.1/.test(origin)) ?? CORS_ORIGINS[0]!;

export interface AlertEmailItem {
  vehicleName: string;
  /** Written once per language: who reads it is decided later, per recipient. */
  message: Localized;
  /** The flota of the vehicle the alert is about; a client only gets the alerts of their own flota. */
  fleetGroup?: string | null;
  /** Goes out as an urgent push (the GPS is down), besides the email. */
  urgent?: boolean;
  /** A repeat of an alert already announced: push only, never another email. */
  reminder?: boolean;
}

function renderAlertEmailHtml(orgName: string, alerts: AlertEmailItem[], language: Language): string {
  const copy = EMAIL_COPY[language] ?? EMAIL_COPY.es;
  const rows = alerts
    .map(
      (a) => `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
            <p style="margin:0;font-weight:600;color:#0f172a;font-size:14px;">${escapeHtml(a.vehicleName)}</p>
            <p style="margin:4px 0 0;color:#64748b;font-size:13px;">${escapeHtml(a.message[language] ?? a.message.es)}</p>
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
              <p style="margin:2px 0 0;color:#e0e7ff;font-size:13px;">${copy.header} — ${escapeHtml(orgName)}</p>
            </td>
          </tr></table>
        </div>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <div style="padding:20px 16px;">
          <a href="${APP_URL}/alertas" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;">
            ${copy.open}
          </a>
          <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">
            ${copy.footer}
          </p>
        </div>
      </div>
    </div>`;
}

interface EmailCopy {
  header: string;
  open: string;
  footer: string;
  one: (vehicle: string) => string;
  many: (count: number) => string;
}

const EMAIL_COPY: Record<Language, EmailCopy> = {
  es: {
    header: "Alertas de tu flota",
    open: "Ver en la app",
    footer: "Podés ajustar qué te avisa en Ajustes &gt; Preferencias de alertas.",
    one: (vehicle: string) => `Alerta: ${vehicle}`,
    many: (count: number) => `${count} alertas nuevas en tu flota`,
  },
  it: {
    header: "Avvisi della tua flotta",
    open: "Apri nell'app",
    footer: "Puoi scegliere quali avvisi ricevere in Impostazioni &gt; Preferenze avvisi.",
    one: (vehicle: string) => `Avviso: ${vehicle}`,
    many: (count: number) => `${count} nuovi avvisi sulla tua flotta`,
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** No-op (logged) if RESEND_API_KEY isn't set — lets the evaluator run in local dev
 * without an email account, and never throws (a delivery failure shouldn't crash the
 * scheduler loop for every other organization). */
export async function sendAlertDigest(to: string, orgName: string, alerts: AlertEmailItem[], language: Language = DEFAULT_LANGUAGE): Promise<void> {
  if (alerts.length === 0) return;

  if (!resend) {
    logger.info({ to, orgName, count: alerts.length }, "RESEND_API_KEY not set — skipping alert email");
    return;
  }

  try {
    await resend.emails.send({
      from: env.ALERT_EMAIL_FROM,
      to,
      subject: alerts.length === 1 ? pick(language, EMAIL_COPY).one(alerts[0]!.vehicleName) : pick(language, EMAIL_COPY).many(alerts.length),
      html: renderAlertEmailHtml(orgName, alerts, language),
    });
  } catch (err) {
    logger.error({ err, to, orgName }, "Failed to send alert email");
  }
}

const LOGIN_CODE_COPY: Record<Language, { subject: (code: string) => string; heading: string; body: string; expires: string; ignore: string }> = {
  es: {
    subject: (code) => `${code} es tu código de acceso a OneSystec`,
    heading: "Tu código de acceso",
    body: "Escribe este código en la pantalla de inicio de sesión:",
    expires: "Vence en 10 minutos y sirve una sola vez.",
    ignore: "Si no intentaste entrar, ignora este correo y cambia tu contraseña: alguien la conoce.",
  },
  it: {
    subject: (code) => `${code} è il tuo codice di accesso a OneSystec`,
    heading: "Il tuo codice di accesso",
    body: "Inserisci questo codice nella schermata di accesso:",
    expires: "Scade tra 10 minuti e vale una sola volta.",
    ignore: "Se non hai provato ad accedere, ignora questa e-mail e cambia la password: qualcuno la conosce.",
  },
};

/** Whether the sign-in codes can go out by email at all: Resend is set up and there is a sender on a verified domain. */
export function canEmailLoginCodes(): boolean {
  return !!resend && !!env.AUTH_EMAIL_FROM;
}

/** The 6-digit sign-in code, by email. True only if the provider accepted the message (Resend reports its refusals instead of throwing). */
export async function sendLoginCodeEmail(to: string, code: string, language: Language = DEFAULT_LANGUAGE): Promise<boolean> {
  if (!resend || !env.AUTH_EMAIL_FROM) return false;
  const copy = pick(language, LOGIN_CODE_COPY);
  try {
    const { error } = await resend.emails.send({
      from: env.AUTH_EMAIL_FROM,
      to,
      subject: copy.subject(code),
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6fb;padding:32px 16px;">
          <div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,0.06);">
            <div style="background:linear-gradient(135deg,#38bdf8,#3b82f6,#7c3aed);padding:20px 24px;">
              <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;">OneSystec</p>
              <p style="margin:2px 0 0;color:#e0e7ff;font-size:13px;">${copy.heading}</p>
            </div>
            <div style="padding:24px;">
              <p style="margin:0 0 12px;color:#334155;font-size:14px;">${copy.body}</p>
              <p style="margin:0 0 16px;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px;color:#0f172a;">${escapeHtml(code)}</p>
              <p style="margin:0 0 8px;color:#64748b;font-size:13px;">${copy.expires}</p>
              <p style="margin:0;color:#94a3b8;font-size:12px;">${copy.ignore}</p>
            </div>
          </div>
        </div>`,
    });
    if (error) {
      logger.error({ err: error, to }, "The email provider refused the sign-in code");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, to }, "Failed to send the sign-in code");
    return false;
  }
}
