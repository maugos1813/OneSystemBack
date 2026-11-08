import websocketPlugin from "@fastify/websocket";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { db } from "../db/client.js";
import type { Position } from "../db/schema/index.js";
import { vehicles } from "../db/schema/index.js";
import { isHonouredLoginToken } from "../api/middlewares/auth.middleware.js";
import type { JwtPayload } from "../api/types.js";
import { isPlatformUser } from "../services/platform.service.js";

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
    try {
      if (!token) throw new Error("missing token");
      const payload = app.jwt.verify<{ userId: string; orgId: string; allowedArea?: string | null; viewAs?: boolean; sid?: string; exp?: number }>(token);
      if (!isHonouredLoginToken(payload as JwtPayload)) throw new Error("token no longer honoured");
      tokenExpiresAt = payload.exp! * 1000;
      orgId = payload.orgId;
      allowedArea = payload.allowedArea;
      userId = payload.userId;
      viewOnly = payload.viewAs === true;
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    // A connection is checked once, when it opens, so it is closed when the token it opened with runs out: the app renews its
    // login and reconnects, and a session that was ended can't keep listening for ever.
    const expiry = setTimeout(() => socket.close(4001, "Token expired"), Math.max(0, Math.min(tokenExpiresAt - Date.now(), 2 ** 31 - 1)));
    socket.on("close", () => clearTimeout(expiry));

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
        const [vehicle] = await db
          .select({ fleetGroup: vehicles.fleetGroup })
          .from(vehicles)
          .where(eq(vehicles.deviceId, event.deviceId))
          .limit(1);
        if (vehicle?.fleetGroup !== allowedArea) return;
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
