import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import "./types.js";
import { registerRealtimeGateway } from "../realtime/gateway.js";
import { apiKeysRoutes } from "./routes/apiKeys.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { devicesRoutes } from "./routes/devices.routes.js";
import { geofencesRoutes } from "./routes/geofences.routes.js";
import { positionsRoutes } from "./routes/positions.routes.js";
import { settingsRoutes } from "./routes/settings.routes.js";
import { vehiclesRoutes } from "./routes/vehicles.routes.js";

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
  // Without an explicit `methods` list, @fastify/cors falls back to a default that
  // excludes PATCH and DELETE — every edit/delete request from the browser (vehicles,
  // API keys, settings, geofences) was failing CORS preflight in production.
  await app.register(cors, { origin: corsOrigins, methods: ["GET", "POST", "PATCH", "DELETE"] });

  await app.register(jwt, { secret: env.JWT_SECRET });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "OneSystem API",
        description:
          "API de la plataforma de rastreo de flotas OneSystem. Todos los datos quedan " +
          "aislados por organización — un token (de login o una API key) solo puede ver " +
          "y modificar los dispositivos, vehículos y posiciones de su propia organización.",
        version: "1.0.0",
      },
      servers: [{ url: env.PUBLIC_API_URL, description: "API" }],
      tags: [
        { name: "Auth", description: "Registro, login y sesión" },
        { name: "API Keys", description: "Credenciales para integraciones de terceros" },
        { name: "Devices", description: "Dispositivos GPS (FMB204)" },
        { name: "Vehicles", description: "Vehículos de la flota" },
        { name: "Positions", description: "Posiciones e histórico de recorrido" },
        { name: "Settings", description: "Nombre de la organización, horario laboral y preferencias de alertas" },
        { name: "Geofences", description: "Geocercas circulares para alertas de entrada/salida" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Token obtenido en /auth/login o /auth/register. Para la app web.",
          },
          apiKeyAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "API key de tu organización (creada en /api-keys), en el mismo header " +
              "Authorization: Bearer <api key>. Para integraciones de terceros.",
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(authRoutes);
  await app.register(apiKeysRoutes);
  await app.register(devicesRoutes);
  await app.register(vehiclesRoutes);
  await app.register(positionsRoutes);
  await app.register(settingsRoutes);
  await app.register(geofencesRoutes);
  await app.register(registerRealtimeGateway);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
