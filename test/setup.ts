// Ensures src/config/env.ts's schema validation passes when tests import server code
// that doesn't touch the database (e.g. the TCP protocol layer), without requiring a
// real .env file in CI or on a fresh checkout.
process.env.DATABASE_URL ??= "postgres://onesystem:onesystem@localhost:5432/onesystem_test";
process.env.JWT_SECRET ??= "test-secret";
