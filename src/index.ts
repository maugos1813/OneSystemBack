import { buildApp } from "./api/app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { publishPosition } from "./realtime/gateway.js";
import { findOrCreateDeviceByImei, touchLastSeen } from "./services/device.service.js";
import { getLatestPosition, storeAvlRecords } from "./services/position.service.js";
import { startTcpServer } from "./tcp-server/server.js";

async function main() {
  const app = await buildApp();
  await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  logger.info({ host: env.HTTP_HOST, port: env.HTTP_PORT }, "HTTP API listening");

  await startTcpServer({
    onIdentify: async (imei) => {
      // Every device is accepted and auto-registered as "unclaimed"; a user later
      // claims it into their organization via POST /devices/claim.
      await findOrCreateDeviceByImei(imei);
      return true;
    },

    onPacket: async (imei, packet) => {
      const device = await findOrCreateDeviceByImei(imei);
      await touchLastSeen(device.id);
      await storeAvlRecords(device.id, packet.records);

      if (device.orgId && packet.records.length > 0) {
        const latest = await getLatestPosition(device.id);
        if (latest) publishPosition(device.orgId, device.id, latest);
      }
    },

    onDisconnect: () => {
      // Nothing to clean up: device state lives in the DB, not in the connection.
    },
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal error starting OneSystem backend");
  process.exit(1);
});
