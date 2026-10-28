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
import { driverVehiclesRoutes } from "./routes/driverVehicles.routes.js";
import { drivingStyleRoutes } from "./routes/drivingStyle.routes.js";
import { geofencesRoutes } from "./routes/geofences.routes.js";
import { positionsRoutes } from "./routes/positions.routes.js";
import { productsRoutes } from "./routes/products.routes.js";
import { publicApiRoutes } from "./routes/publicApi.routes.js";
import { settingsRoutes } from "./routes/settings.routes.js";
import { vehicleDocumentsRoutes } from "./routes/vehicleDocuments.routes.js";
import { pushTokensRoutes } from "./routes/pushTokens.routes.js";
import { maintenanceRoutes } from "./routes/maintenance.routes.js";
import { simsRoutes } from "./routes/sims.routes.js";
import { teamUsersRoutes } from "./routes/teamUsers.routes.js";
import { tollsRoutes } from "./routes/tolls.routes.js";
import { vehiclesRoutes } from "./routes/vehicles.routes.js";

export async function buildApp() {
  // Behind Railway's proxy, request.ip must be the client's (not the proxy's) for the login limits: trust exactly one proxy, so the address
  // is the one that proxy appended to X-Forwarded-For and a client cannot pick its own by sending an X-Forwarded-For of its own.
  // (The function form is on purpose: in Fastify 5 a bare number does not behave as "n proxies".)
  const app = Fastify({ loggerInstance: logger, trustProxy: (_address, hop) => hop < 1 });

  // The API only answers JSON to our own front-ends: no sniffing, no framing, no referrer leaks, HTTPS only.
  app.addHook("onSend", async (_request, reply) => {
    void reply.headers({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    });
  });

  const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
  // Without an explicit `methods` list, @fastify/cors falls back to a default that
  // excludes PATCH and DELETE — every edit/delete request from the browser (vehicles,
  // API keys, settings, geofences) was failing CORS preflight in production.
  await app.register(cors, { origin: corsOrigins, methods: ["GET", "POST", "PATCH", "DELETE"] });

  await app.register(jwt, { secret: env.JWT_SECRET });

  await app.register(swagger, {
    // The public /v1 API has its own document (/v1/docs); /docs is the app's internal API.
    transform: ({ schema, url }) => ({ schema: url.startsWith("/v1") ? { ...schema, hide: true } : schema, url }),
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "OneSystec API",
        description:
          "API interna de la app OneSystec (sesión de usuario). Todos los datos quedan aislados por " +
          "organización. Para integrar otras apps usá la API pública de solo lectura: /v1/docs.",
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
        { name: "Products", description: "Catálogo de productos OneSystec habilitados por organización" },
        { name: "Team", description: "Miembros de la organización: roles y qué cards puede ver cada uno" },
        { name: "SIMs", description: "Tarjetas SIM de los trackers (ICCID, número, NMU, PIN/PUK); solo owner/admin" },
        { name: "Tolls", description: "Pasos de los vehículos por peajes, detectados a partir de su recorrido" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Token obtenido en /auth/login o /auth/register. Para la app web.",
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
  await app.register(productsRoutes);
  await app.register(teamUsersRoutes);
  await app.register(drivingStyleRoutes);
  await app.register(publicApiRoutes, { prefix: "/v1" });
  await app.register(tollsRoutes);
  await app.register(simsRoutes);
  await app.register(maintenanceRoutes);
  await app.register(vehicleDocumentsRoutes);
  await app.register(pushTokensRoutes);
  await app.register(driverVehiclesRoutes);
  await app.register(registerRealtimeGateway);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
