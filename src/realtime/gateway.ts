import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { requireAuth } from "../api/middlewares/auth.middleware.js";
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

export async function registerRealtimeGateway(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.register(async (scoped) => {
    scoped.addHook("onRequest", requireAuth);

    scoped.get("/realtime/positions", { websocket: true }, (socket, request) => {
      const orgId = request.user.orgId;

      const onPosition = (event: { deviceId: string; position: Position }) => {
        socket.send(JSON.stringify({ type: "position", ...event }));
      };
      positionEvents.on(orgId, onPosition);

      socket.on("close", () => {
        positionEvents.off(orgId, onPosition);
      });
    });
  });
}
