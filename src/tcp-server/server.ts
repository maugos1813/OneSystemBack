import net, { type Server } from "node:net";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { handleDeviceConnection, type DeviceConnectionHooks } from "./connectionHandler.js";

export function createTcpServer(hooks: DeviceConnectionHooks): Server {
  // Each connection logs its own arrival (with its id) from inside the handler.
  const server = net.createServer((socket) => handleDeviceConnection(socket, hooks));

  server.on("error", (err) => {
    logger.error({ err }, "TCP server error");
  });

  return server;
}

export function startTcpServer(hooks: DeviceConnectionHooks): Promise<Server> {
  const server = createTcpServer(hooks);
  return new Promise((resolve) => {
    server.listen(env.TCP_PORT, env.TCP_HOST, () => {
      logger.info({ host: env.TCP_HOST, port: env.TCP_PORT }, "TCP ingestion server listening");
      resolve(server);
    });
  });
}
