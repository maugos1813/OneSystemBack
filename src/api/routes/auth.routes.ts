import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { authenticate, findUserById, getCurrentUser, verifyUserPassword } from "../../services/auth.service.js";
import {
  confirmTotpSetup,
  disableTotp,
  generateRecoveryCodes,
  getMfaStatus,
  isAuthenticatorRequired,
  isTotpRequired,
  startTotpSetup,
  verifySecondFactor,
} from "../../services/mfa.service.js";
import { issueEmailCode, isEmailCodeLoginAvailable, maskEmail, verifyEmailCode } from "../../services/emailCode.service.js";
import { toLanguage } from "../../services/i18n.js";
import { signMfaToken, verifyMfaToken } from "../../services/mfaToken.js";
import { recordLoginFailure } from "../../services/platformAlerts.service.js";
import { getOrganizationBrief, isPlatformUser } from "../../services/platform.service.js";
import type { User } from "../../db/schema/index.js";
import {
  createSession,
  getSession,
  listUserSessions,
  revokeAllUserSessions,
  revokeByRefreshToken,
  revokeSessionsById,
  revokeUserSession,
  rotateSession,
  type SessionClient,
} from "../../services/userSession.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { clientAddress, rateLimitLogin, rateLimitQrAction, rateLimitQrPoll, rateLimitQrStart, rateLimitSecondFactor } from "../middlewares/loginRateLimit.js";
import { approveQrLogin, claimQrLogin, denyQrLogin, inspectQrLogin, QR_LOGIN_TTL_MS, startQrLogin } from "../../services/qrLogin.service.js";

const clientSchema = z.enum(["web", "app"]).default("web");

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** "app" for the Android apps (their sessions last longer), "web" for a browser. */
  client: clientSchema,
  /** Kept for the apps already installed (they still send it); the second step no longer depends on the device. */
  channel: z.enum(["web", "phone"]).optional(),
});
const emailLoginSchema = z.object({ mfaToken: z.string().min(1), code: z.string().min(6).max(8) });
const emailResendSchema = z.object({ mfaToken: z.string().min(1) });

const code = z.string().min(6).max(8);
const mfaLoginSchema = z
  .object({ mfaToken: z.string().min(1), code: code.optional(), recoveryCode: z.string().min(8).max(20).optional() })
  .refine((body) => !!body.code !== !!body.recoveryCode, { message: "Send either code or recoveryCode" });
const mfaSetupSchema = z.object({ mfaToken: z.string().min(1) });
const mfaEnableLoginSchema = z.object({ mfaToken: z.string().min(1), code });
const enableSchema = z.object({ code });
const sensitiveSchema = z
  .object({ password: z.string().min(1), code: code.optional(), recoveryCode: z.string().min(8).max(20).optional() })
  .refine((body) => !!body.code !== !!body.recoveryCode, { message: "Send either code or recoveryCode" });
const qrCodeSchema = z.object({ code: z.string().min(10).max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const logoutSchema = z.object({ refreshToken: z.string().min(1).optional() });

const AUTH = [{ bearerAuth: [] }];

/** A login token plus the refresh token that renews it (`token` keeps the name older callers read). */
async function openSession(
  app: FastifyInstance,
  request: FastifyRequest,
  user: Pick<User, "id" | "orgId" | "role" | "allowedArea">,
  client: SessionClient,
  mfa: boolean,
  /** For a session that opens on a device other than the one making this request (the computer that showed a QR). */
  device?: { userAgent: string; ip: string | null },
) {
  const { session, refreshToken } = await createSession({
    userId: user.id,
    client,
    mfa,
    userAgent: device ? device.userAgent : request.headers["user-agent"],
    ip: device ? (device.ip ?? undefined) : clientAddress(request),
  });
  return { token: signLoginToken(app, user, session.id), refreshToken, expiresIn: 15 * 60, sessionId: session.id };
}

function signLoginToken(app: FastifyInstance, user: Pick<User, "id" | "orgId" | "role" | "allowedArea">, sessionId: string): string {
  return app.jwt.sign({ userId: user.id, orgId: user.orgId, role: user.role, allowedArea: user.allowedArea, sid: sessionId });
}

/** For the routes that are about a person's own login: a login token (not an API key, which has no person behind it). */
async function requireLoginToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (request.apiKeyId) await reply.code(403).send({ error: "Forbidden" });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Accounts are opened by OneSystec (Clientes, in the app), never by the public: this stays answering so old callers get a clear no.
  app.post(
    "/auth/register",
    { schema: { tags: ["Auth"], summary: "Cerrado: las cuentas las crea OneSystec", hide: true } },
    async (_request, reply) => reply.code(403).send({ error: "Registration is closed: accounts are created by OneSystec" }),
  );

  app.post(
    "/auth/login",
    {
      preHandler: rateLimitLogin,
      schema: {
        tags: ["Auth"],
        summary: "Iniciar sesión: devuelve el token y el refreshToken, o pide el segundo paso (mfaRequired / mfaSetupRequired)",
        body: zodToJsonSchema(loginSchema),
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const user = await authenticate(parsed.data.email, parsed.data.password);
      if (!user) {
        // Counted for OneSystec's security watch; never allowed to break the answer.
        await recordLoginFailure(parsed.data.email).catch(() => undefined);
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const { client } = parsed.data;
      const needsSecondStep = !!user.totpEnabledAt || isTotpRequired(user.role);
      // The second step is a code sent to the account's email, on a phone and on a computer alike (so several people who read the same
      // mailbox can share an account, and a lost phone locks nobody out). When email isn't set up, the authenticator app is what is
      // asked for instead (and an admin must set it up first), so nobody is locked out.
      if (needsSecondStep && isEmailCodeLoginAvailable()) {
        const sent = await issueEmailCode({ id: user.id, email: user.email, language: toLanguage(user.language) });
        if (sent.outcome === "limit") return reply.code(429).send({ error: "Too many attempts. Try again later." });
        if (sent.outcome === "sent" || sent.outcome === "recent") {
          return {
            mfaRequired: true,
            method: "email",
            mfaToken: signMfaToken({ userId: user.id, purpose: "mfa-email", client }),
            emailHint: maskEmail(user.email),
            // An account that also has the authenticator app can use it instead.
            ...(user.totpEnabledAt ? { alternativeMfaToken: signMfaToken({ userId: user.id, purpose: "mfa", client }) } : {}),
          };
        }
        // The email could not be sent: with an authenticator the person can still get in; without one there is nothing to fall back on.
        if (!user.totpEnabledAt) return reply.code(503).send({ error: "Could not send the email" });
      }
      // The password was right, but that isn't enough: an account with an authenticator is asked for its code, and an admin that
      // has none yet must set one up before it gets in. Until then the only thing handed out is a short note saying so.
      if (user.totpEnabledAt) {
        return { mfaRequired: true, mfaToken: signMfaToken({ userId: user.id, purpose: "mfa", client }) };
      }
      if (isTotpRequired(user.role)) {
        return { mfaSetupRequired: true, mfaToken: signMfaToken({ userId: user.id, purpose: "mfa-setup", client }) };
      }
      return reply.send(await openSession(app, request, user, client, false));
    },
  );

  // --- Second step of a sign-in
  app.post(
    "/auth/login/totp",
    {
      schema: {
        tags: ["Auth"],
        summary: "Segundo paso: el código del autenticador (o un código de recuperación) tras la contraseña",
        body: zodToJsonSchema(mfaLoginSchema),
      },
    },
    async (request, reply) => {
      const parsed = mfaLoginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claims = verifyMfaToken(parsed.data.mfaToken, "mfa");
      if (!claims) return reply.code(401).send({ error: "Sign-in expired, start again" });
      if (await rateLimitSecondFactor(request, reply, claims.userId)) return;

      const user = await findUserById(claims.userId);
      const used = user ? await verifySecondFactor(user.id, { code: parsed.data.code, recoveryCode: parsed.data.recoveryCode }) : null;
      if (!user || !used) {
        if (user) await recordLoginFailure(user.email).catch(() => undefined);
        return reply.code(401).send({ error: "Invalid code" });
      }
      const status = await getMfaStatus(user);
      return reply.send({ ...(await openSession(app, request, user, claims.client, true)), usedRecoveryCode: used === "recovery", recoveryCodesLeft: status.recoveryCodesLeft });
    },
  );

  // --- Second step by email (phone sign-ins)
  app.post(
    "/auth/login/email",
    { schema: { tags: ["Auth"], summary: "Segundo paso en el celular: el código de 6 dígitos enviado por correo", body: zodToJsonSchema(emailLoginSchema) } },
    async (request, reply) => {
      const parsed = emailLoginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claims = verifyMfaToken(parsed.data.mfaToken, "mfa-email");
      if (!claims) return reply.code(401).send({ error: "Sign-in expired, start again" });
      if (await rateLimitSecondFactor(request, reply, claims.userId)) return;

      const user = await findUserById(claims.userId);
      if (!user || !(await verifyEmailCode(user.id, parsed.data.code))) {
        if (user) await recordLoginFailure(user.email).catch(() => undefined);
        return reply.code(401).send({ error: "Invalid code" });
      }
      return reply.send(await openSession(app, request, user, claims.client, true));
    },
  );

  app.post(
    "/auth/login/email/resend",
    { schema: { tags: ["Auth"], summary: "Enviar de nuevo el código por correo", body: zodToJsonSchema(emailResendSchema) } },
    async (request, reply) => {
      const parsed = emailResendSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claims = verifyMfaToken(parsed.data.mfaToken, "mfa-email");
      if (!claims) return reply.code(401).send({ error: "Sign-in expired, start again" });
      const user = await findUserById(claims.userId);
      if (!user) return reply.code(401).send({ error: "Sign-in expired, start again" });
      const sent = await issueEmailCode({ id: user.id, email: user.email, language: toLanguage(user.language) });
      if (sent.outcome === "recent") {
        void reply.header("Retry-After", sent.retryAfterSec);
        return reply.code(429).send({ error: "Too many attempts. Try again later.", retryAfterSeconds: sent.retryAfterSec });
      }
      if (sent.outcome === "limit") return reply.code(429).send({ error: "Too many attempts. Try again later." });
      if (sent.outcome === "failed") return reply.code(503).send({ error: "Could not send the email" });
      return reply.code(204).send();
    },
  );

  // --- An admin without an authenticator yet: set it up during the sign-in itself
  app.post(
    "/auth/login/totp/setup",
    { schema: { tags: ["Auth"], summary: "Empezar a configurar el autenticador durante el inicio de sesión", body: zodToJsonSchema(mfaSetupSchema) } },
    async (request, reply) => {
      const parsed = mfaSetupSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claims = verifyMfaToken(parsed.data.mfaToken, "mfa-setup");
      if (!claims) return reply.code(401).send({ error: "Sign-in expired, start again" });
      const setup = await startTotpSetup(claims.userId);
      if (!setup) return reply.code(409).send({ error: "Authenticator already set up" });
      return setup;
    },
  );

  app.post(
    "/auth/login/totp/enable",
    { schema: { tags: ["Auth"], summary: "Confirmar el autenticador con su primer código: abre la sesión y entrega los códigos de recuperación", body: zodToJsonSchema(mfaEnableLoginSchema) } },
    async (request, reply) => {
      const parsed = mfaEnableLoginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claims = verifyMfaToken(parsed.data.mfaToken, "mfa-setup");
      if (!claims) return reply.code(401).send({ error: "Sign-in expired, start again" });
      if (await rateLimitSecondFactor(request, reply, claims.userId)) return;
      const confirmed = await confirmTotpSetup(claims.userId, parsed.data.code);
      const user = await findUserById(claims.userId);
      if (!confirmed || !user) return reply.code(401).send({ error: "Invalid code" });
      return reply.send({ ...(await openSession(app, request, user, claims.client, true)), recoveryCodes: confirmed.recoveryCodes });
    },
  );

  // --- "Enter with the phone": the computer shows a QR, a phone that is already signed in authorizes it
  app.post(
    "/auth/qr/start",
    { preHandler: rateLimitQrStart, schema: { tags: ["Auth"], summary: "Pedir un QR para entrar con el celular (lo muestra la pantalla de login de la web)" } },
    async (request) => {
      const { code, expiresAt } = await startQrLogin({ userAgent: request.headers["user-agent"], ip: clientAddress(request) });
      return { code, expiresAt, expiresInSec: QR_LOGIN_TTL_MS / 1000 };
    },
  );

  app.post(
    "/auth/qr/poll",
    { preHandler: rateLimitQrPoll, schema: { tags: ["Auth"], summary: "¿Ya autorizó el celular? Si sí, entrega la sesión (una sola vez)", body: zodToJsonSchema(qrCodeSchema) } },
    async (request, reply) => {
      const parsed = qrCodeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const claim = await claimQrLogin(parsed.data.code);
      if (claim.status !== "approved") return { status: claim.status };
      const user = await findUserById(claim.userId);
      // An account that must pass a second step is only let in by a phone whose own session passed it (approval checks this too).
      if (!user || (isTotpRequired(user.role) && !claim.mfa)) return { status: "expired" };
      const session = await openSession(app, request, user, claim.client, claim.mfa, { userAgent: claim.userAgent, ip: claim.ip });
      return { status: "approved", ...session };
    },
  );

  app.post(
    "/auth/qr/inspect",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Desde el celular: qué computador pide entrar (antes de autorizar)", security: AUTH, body: zodToJsonSchema(qrCodeSchema) } },
    async (request, reply) => {
      const parsed = qrCodeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (await rateLimitQrAction(request, reply, request.user.userId)) return;
      const info = await inspectQrLogin(parsed.data.code);
      if (!info) return reply.code(404).send({ error: "QR expired or not valid" });
      return info;
    },
  );

  app.post(
    "/auth/qr/approve",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Desde el celular: autorizar que ese computador entre con mi cuenta", security: AUTH, body: zodToJsonSchema(qrCodeSchema) } },
    async (request, reply) => {
      const parsed = qrCodeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (await rateLimitQrAction(request, reply, request.user.userId)) return;

      // Only a phone app that is itself signed in can open a computer, and one whose own sign-in passed the second step if the account has one.
      const session = request.user.sid ? await getSession(request.user.sid) : null;
      if (!session || session.revokedAt || session.client !== "app") {
        return reply.code(403).send({ error: "Solo la app del celular puede autorizar un acceso" });
      }
      const user = await findUserById(request.user.userId);
      if (!user) return reply.code(404).send({ error: "User not found" });
      if ((!!user.totpEnabledAt || isTotpRequired(user.role)) && !session.mfa) {
        return reply.code(403).send({ error: "Vuelve a iniciar sesión en la app para poder autorizar" });
      }
      const result = await approveQrLogin(parsed.data.code, { userId: user.id, mfa: session.mfa });
      if (result !== "ok") return reply.code(404).send({ error: "QR expired or not valid" });
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/qr/deny",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Desde el celular: rechazar el acceso pedido por ese QR", security: AUTH, body: zodToJsonSchema(qrCodeSchema) } },
    async (request, reply) => {
      const parsed = qrCodeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (await rateLimitQrAction(request, reply, request.user.userId)) return;
      await denyQrLogin(parsed.data.code);
      return reply.code(204).send();
    },
  );

  // --- Keeping the session alive, and ending it
  app.post(
    "/auth/refresh",
    { schema: { tags: ["Auth"], summary: "Renovar el token con el refreshToken (se entrega uno nuevo; el anterior deja de servir)", body: zodToJsonSchema(refreshSchema) } },
    async (request, reply) => {
      const parsed = refreshSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const result = await rotateSession(parsed.data.refreshToken);
      if (result.outcome === "reuse") {
        request.log.warn({ userId: result.userId }, "A used refresh token was presented again: its session was ended");
        return reply.code(401).send({ error: "Session expired" });
      }
      if (result.outcome !== "ok") return reply.code(401).send({ error: "Session expired" });

      // What the account is NOW is what the new token says (a role changed, an organization moved), not what it was at sign-in.
      const user = await findUserById(result.session.userId);
      if (!user || (isTotpRequired(user.role) && !result.session.mfa)) {
        // An account that became an admin since it signed in (so its session never passed a second step) has to come back through the login.
        await revokeSessionsById([result.session.id]);
        return reply.code(401).send({ error: "Session expired" });
      }
      return reply.send({
        token: signLoginToken(app, user, result.session.id),
        refreshToken: result.refreshToken,
        expiresIn: 15 * 60,
        sessionId: result.session.id,
      });
    },
  );

  app.post(
    "/auth/logout",
    { schema: { tags: ["Auth"], summary: "Cerrar esta sesión (con el token, o con el refreshToken si el token ya venció)", body: zodToJsonSchema(logoutSchema) } },
    async (request, reply) => {
      const parsed = logoutSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      // Signing out never fails for being late: whatever proof of the session is given is used.
      try {
        await request.jwtVerify();
        if (request.user.sid) await revokeSessionsById([request.user.sid]);
      } catch {
        /* the login token had already run out: the refresh token is the proof */
      }
      if (parsed.data.refreshToken) await revokeByRefreshToken(parsed.data.refreshToken);
      return reply.code(204).send();
    },
  );

  app.get(
    "/auth/sessions",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Mis sesiones abiertas (dispositivos)", security: AUTH } },
    async (request) => listUserSessions(request.user.userId, request.user.sid),
  );

  app.delete<{ Params: { id: string } }>(
    "/auth/sessions/:id",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Cerrar una de mis sesiones", security: AUTH } },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      const ok = await revokeUserSession(request.user.userId, id.data);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "Session not found" });
    },
  );

  app.post(
    "/auth/sessions/revoke-others",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Cerrar todas mis sesiones menos esta", security: AUTH } },
    async (request) => ({ revoked: await revokeAllUserSessions(request.user.userId, request.user.sid) }),
  );

  // --- The authenticator, for someone already signed in (Ajustes → Seguridad)
  app.get(
    "/auth/security",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Estado del segundo paso de mi cuenta", security: AUTH } },
    async (request, reply) => {
      const user = await findUserById(request.user.userId);
      if (!user) return reply.code(404).send({ error: "User not found" });
      return getMfaStatus(user);
    },
  );

  app.post(
    "/auth/totp/setup",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Empezar a configurar el autenticador", security: AUTH } },
    async (request, reply) => {
      const setup = await startTotpSetup(request.user.userId);
      if (!setup) return reply.code(409).send({ error: "Authenticator already set up" });
      return setup;
    },
  );

  app.post(
    "/auth/totp/enable",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Confirmar el autenticador con su primer código", security: AUTH, body: zodToJsonSchema(enableSchema) } },
    async (request, reply) => {
      const parsed = enableSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (await rateLimitSecondFactor(request, reply, request.user.userId)) return;
      const confirmed = await confirmTotpSetup(request.user.userId, parsed.data.code);
      // 400, not 401: for someone who is signed in a 401 means "your session ended", and this is only a wrong code.
      if (!confirmed) return reply.code(400).send({ error: "Invalid code" });
      return confirmed;
    },
  );

  /** Password plus a code (or recovery code): what is asked again before touching the second step itself. */
  async function confirmSensitive(request: FastifyRequest, reply: FastifyReply, body: z.infer<typeof sensitiveSchema>): Promise<boolean> {
    if (await rateLimitSecondFactor(request, reply, request.user.userId)) return false;
    const passwordOk = await verifyUserPassword(request.user.userId, body.password);
    const factor = passwordOk ? await verifySecondFactor(request.user.userId, { code: body.code, recoveryCode: body.recoveryCode }) : null;
    if (!factor) {
      // 403, not 401 (that would read as "your session ended" to the app).
      await reply.code(403).send({ error: "Invalid password or code" });
      return false;
    }
    return true;
  }

  app.post(
    "/auth/totp/disable",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Quitar el autenticador (pide la contraseña y un código); los administradores no pueden", security: AUTH, body: zodToJsonSchema(sensitiveSchema) } },
    async (request, reply) => {
      const parsed = sensitiveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (isAuthenticatorRequired(request.user.role)) return reply.code(403).send({ error: "El autenticador es obligatorio para tu rol" });
      if (!(await confirmSensitive(request, reply, parsed.data))) return;
      await disableTotp(request.user.userId);
      await revokeAllUserSessions(request.user.userId, request.user.sid);
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/totp/recovery-codes",
    { preHandler: requireLoginToken, schema: { tags: ["Auth"], summary: "Generar códigos de recuperación nuevos (los anteriores dejan de servir)", security: AUTH, body: zodToJsonSchema(sensitiveSchema) } },
    async (request, reply) => {
      const parsed = sensitiveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (!(await confirmSensitive(request, reply, parsed.data))) return;
      return { recoveryCodes: await generateRecoveryCodes(request.user.userId) };
    },
  );

  app.get(
    "/me",
    {
      onRequest: requireAuth,
      schema: {
        tags: ["Auth"],
        summary: "Datos del usuario y organización autenticados",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const me = await getCurrentUser(request.user.userId);
      if (!me) return reply.code(404).send({ error: "User not found" });
      const isPlatform = await isPlatformUser(me.userId);
      // OneSystec looking at a client: the account answers as that client's, and says so.
      if (request.user.viewAs && isPlatform) {
        const org = await getOrganizationBrief(request.user.orgId);
        if (org) {
          return {
            ...me,
            role: "admin" as const,
            orgId: org.id,
            orgName: org.name,
            orgLogo: org.logo,
            isPlatform,
            viewingAs: { orgId: org.id, orgName: org.name },
          };
        }
      }
      return { ...me, isPlatform };
    },
  );
}
