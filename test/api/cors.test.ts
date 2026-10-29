import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";

/** The browser asks permission (a preflight) before any request that is not a plain GET/POST; a method missing here fails as "Failed to fetch". */
describe("CORS preflight", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    it(`lets the app's own site use ${method}`, async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/maintenance/vehicles/123e4567-e89b-12d3-a456-426614174000/odometer",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    });
  }
});
