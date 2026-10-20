import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** The client's logo: validation, saving it at registration, reading it back and changing it in Ajustes. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { logoSchema } = await import("../../src/services/orgLogo.js");
const { registerOrganizationWithOwner, getCurrentUser } = await import("../../src/services/auth.service.js");
const { updateSettings } = await import("../../src/services/settings.service.js");
const { organizations } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

// A 1x1 PNG, the smallest valid thing the regex has to accept.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text,
      plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '',
      email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer',
      parent_user_id uuid, allowed_area varchar(50), created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await clientModule.__pg.close();
});

describe("logoSchema", () => {
  it("accepts PNG, JPEG and WebP data URLs", () => {
    expect(logoSchema.safeParse(PNG).success).toBe(true);
    expect(logoSchema.safeParse("data:image/jpeg;base64,/9j/4AAQSkZJRg==").success).toBe(true);
    expect(logoSchema.safeParse("data:image/webp;base64,UklGRhoAAABXRUJQ").success).toBe(true);
  });

  it("rejects SVG (it can carry script), other types, plain URLs and oversized images", () => {
    expect(logoSchema.safeParse("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").success).toBe(false);
    expect(logoSchema.safeParse("data:text/html;base64,PGgxPg==").success).toBe(false);
    expect(logoSchema.safeParse("https://example.com/logo.png").success).toBe(false);
    expect(logoSchema.safeParse("data:image/png;base64,").success).toBe(false);
    expect(logoSchema.safeParse(`data:image/png;base64,${"A".repeat(400_000)}`).success).toBe(false);
  });
});

describe("the logo of an organization", () => {
  it("is saved at registration and comes back with the current user", async () => {
    const { user } = await registerOrganizationWithOwner({ orgName: "Gamonal", email: "a@gamonal.it", password: "supersecret1", logo: PNG });
    expect(await getCurrentUser(user.id)).toMatchObject({ orgName: "Gamonal", orgLogo: PNG });
  });

  it("is null when none was given", async () => {
    const { user } = await registerOrganizationWithOwner({ orgName: "Sin logo", email: "b@gamonal.it", password: "supersecret1" });
    expect((await getCurrentUser(user.id))?.orgLogo).toBeNull();
  });

  it("is set, kept and removed from the settings", async () => {
    const { orgId, user } = await registerOrganizationWithOwner({ orgName: "Cambio", email: "c@gamonal.it", password: "supersecret1" });
    await updateSettings(orgId, { orgLogo: PNG });
    expect((await getCurrentUser(user.id))?.orgLogo).toBe(PNG);

    await updateSettings(orgId, { orgName: "Cambio SRL" });
    const [kept] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(kept).toMatchObject({ name: "Cambio SRL", logo: PNG });

    await updateSettings(orgId, { orgLogo: null });
    expect((await getCurrentUser(user.id))?.orgLogo).toBeNull();
  });
});
