import { migrate } from "drizzle-orm/node-postgres/migrator";
import { logger } from "../config/logger.js";
import { db, pool } from "./client.js";

async function main() {
  logger.info("running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("migrations complete");
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
