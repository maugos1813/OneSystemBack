import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { Position } from "../db/schema/index.js";
import { isHonouredLoginToken } from "../api/middlewares/auth.middleware.js";
import type { JwtPayload } from "../api/types.js";
import { isPlatformUser } from "../services/platform.service.js";
import { isSessionRevoked } from "../services/userSession.service.js";
import { fleetGroupOfDevice } from "./deviceFleet.js";

/**
 * Simple in-process pub/sub keyed by orgId. Good enough for a single API instance;
 * swap for a Redis pub/sub channel if this ever runs behind more than one replica.
 */
const positionEvents = new EventEmitter();
positionEvents.setMaxListeners(0);

/** The channel OneSystec listens on to see every device of every client (and the ones no client has claimed yet). */
const ALL_CLIENTS = "*";

/** `orgId` is null for a device nobody has claimed yet: only OneSystec's all-clients map hears it. */
export function publishPosition(orgId: string | null, deviceId: string, position: Position): void {
  if (orgId) positionEvents.emit(orgId, { deviceId, position });
  positionEvents.emit(ALL_CLIENTS, { deviceId, position });
}

// Send a ping frequently enough that Railway's edge proxy (and any other intermediary)
// never sees a connection idle long enough to reap it — position events alone wouldn't
// be frequent enough for a parked vehicle.
const HEARTBEAT_INTERVAL_MS = 25_000;
/** How long a connection may stay open (the longest a browser session may sit unused). The client then reconnects by itself. */
const SOCKET_MAX_MS = 8 * 3_600_000;
/** How often an open connection checks that its session wasn't signed out. */
const SESSION_CHECK_MS = 20_000;

export async function registerRealtimeGateway(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/realtime/positions", { websocket: true }, async (socket, request) => {
    // A browser's WebSocket constructor can't set an Authorization header on the
    // handshake, so the JWT travels as a query param here instead — same token the
    // frontend already holds from login, just verified manually rather than via the
    // requireAuth middleware the REST routes use.
    const { token, scope } = request.query as { token?: string; scope?: string };
    let orgId: string;
    let allowedArea: string | null | undefined;
    let userId: string;
    let viewOnly = false;
    let tokenExpiresAt = 0;
    let sessionId: string | undefined;
    try {
      if (!token) throw new Error("missing token");
      const payload = app.jwt.verify<{ userId: string; orgId: string; allowedArea?: string | null; viewAs?: boolean; actingAs?: boolean; sid?: string; exp?: number }>(token);
      if (!isHonouredLoginToken(payload as JwtPayload)) throw new Error("token no longer honoured");
      tokenExpiresAt = payload.exp! * 1000;
      sessionId = payload.sid;
      orgId = payload.orgId;
      allowedArea = payload.allowedArea;
      userId = payload.userId;
      viewOnly = payload.viewAs === true || payload.actingAs === true; // neither is OneSystec's own session: no all-clients channel
      if (payload.actingAs === true && !(await isPlatformUser(payload.userId))) throw new Error("not OneSystec any more");
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    // A connection is checked once, when it opens, so it is tied to its session: it ends when that session is signed out (checked
    // every few seconds) or after SOCKET_MAX_MS, and the app reconnects with a fresh login. It must NOT end with the 15-minute login
    // token: every reconnection costs the client a full snapshot. A token with no session (the 2-hour view of a client) ends with itself.
    const closeAt = sessionId ? Date.now() + SOCKET_MAX_MS : tokenExpiresAt;
    const expiry = setTimeout(() => socket.close(4001, "Token expired"), Math.max(0, Math.min(closeAt - Date.now(), 2 ** 31 - 1)));
    const sessionWatch = sessionId
      ? setInterval(() => {
          if (isSessionRevoked(sessionId)) socket.close(4001, "Session ended");
        }, SESSION_CHECK_MS)
      : undefined;
    socket.on("close", () => {
      clearTimeout(expiry);
      if (sessionWatch) clearInterval(sessionWatch);
    });

    // OneSystec's own map: every device of every client. Only its people, and never through a "viewing a client" token.
    if (scope === "all") {
      if (viewOnly || !(await isPlatformUser(userId))) {
        socket.close(4003, "Forbidden");
        return;
      }
      const onAny = (event: { deviceId: string; position: Position }) => socket.send(JSON.stringify({ type: "position", ...event }));
      positionEvents.on(ALL_CLIENTS, onAny);
      const heartbeatAll = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), HEARTBEAT_INTERVAL_MS);
      socket.on("close", () => {
        positionEvents.off(ALL_CLIENTS, onAny);
        clearInterval(heartbeatAll);
      });
      return;
    }

    const onPosition = async (event: { deviceId: string; position: Position }) => {
      // A hard área restriction must hold here too — this channel bypasses the REST
      // layer entirely, so without this check a restricted user would still see every
      // other área's positions pushed straight at them regardless of what /vehicles
      // returns.
      if (allowedArea) {
        if ((await fleetGroupOfDevice(event.deviceId)) !== allowedArea) return;
      }
      socket.send(JSON.stringify({ type: "position", ...event }));
    };
    positionEvents.on(orgId, onPosition);

    const heartbeat = setInterval(() => {
      socket.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("close", () => {
      positionEvents.off(orgId, onPosition);
      clearInterval(heartbeat);
    });
  });
}
