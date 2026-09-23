import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TCP_PORT: z.coerce.number().int().positive().default(5027),
  TCP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  HTTP_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  // Comma-separated list of origins allowed to call the API from a browser (the frontend's URL(s)).
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Public base URL of this API, shown as the server in the OpenAPI docs (/docs).
  PUBLIC_API_URL: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
