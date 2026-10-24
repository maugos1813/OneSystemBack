import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Several files boot their own in-memory Postgres (PGlite); with them all starting at once on a busy machine
    // the default 10 s for a setup hook is not enough, and a file would fail without any test being wrong.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
