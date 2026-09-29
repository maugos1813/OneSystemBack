import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { Position } from "../db/schema/index.js";

/**
 * Simple in-process pub/sub keyed by orgId. Good enough for a single API instance;
 * swap for a Redis pub/sub channel if this ever runs behind more than one replica.
 */
const positionEvents = new EventEmitter();
positionEvents.setMaxListeners(0);

export function publishPosition(orgId: string, deviceId: string, position: Position): void {
  positionEvents.emit(orgId, { deviceId, position });
}

// Send a ping frequently enough that Railway's edge proxy (and any other intermediary)
// never sees a connection idle long enough to reap it — position events alone wouldn't
// be frequent enough for a parked vehicle.
const HEARTBEAT_INTERVAL_MS = 25_000;

export async function registerRealtimeGateway(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/realtime/positions", { websocket: true }, (socket, request) => {
    // A browser's WebSocket constructor can't set an Authorization header on the
    // handshake, so the JWT travels as a query param here instead — same token the
    // frontend already holds from login, just verified manually rather than via the
    // requireAuth middleware the REST routes use.
    const { token } = request.query as { token?: string };
    let orgId: string;
    try {
      if (!token) throw new Error("missing token");
      const payload = app.jwt.verify<{ orgId: string }>(token);
      orgId = payload.orgId;
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    const onPosition = (event: { deviceId: string; position: Position }) => {
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
