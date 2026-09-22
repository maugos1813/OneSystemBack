import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import "./types.js";
import { registerRealtimeGateway } from "../realtime/gateway.js";
import { authRoutes } from "./routes/auth.routes.js";
import { devicesRoutes } from "./routes/devices.routes.js";
import { positionsRoutes } from "./routes/positions.routes.js";
import { vehiclesRoutes } from "./routes/vehicles.routes.js";

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
  await app.register(cors, { origin: corsOrigins });

  await app.register(jwt, { secret: env.JWT_SECRET });

  await app.register(authRoutes);
  await app.register(devicesRoutes);
  await app.register(vehiclesRoutes);
  await app.register(positionsRoutes);
  await app.register(registerRealtimeGateway);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
