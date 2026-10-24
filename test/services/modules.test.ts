import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** The OneTrack sections an admin gives a client: the catalog, the packages, and how they are stored and read. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { MODULE_KEYS, MODULE_TEMPLATES, DEFAULT_MODULES, resolveModules, sanitizeModules } = await import("../../src/services/modules.js");
const { registerOrganizationWithOwner, getCurrentUser } = await import("../../src/services/auth.service.js");
const { createTeamMember, updateTeamMemberModules, listTeamMembers } = await import("../../src/services/teamUser.service.js");
const { getUserModules } = await import("../../src/services/userModules.service.js");
const pg = clientModule.__pg;

beforeAll(async () => {
  await pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text,
      plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '',
      email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer',
      parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE user_products (user_id uuid NOT NULL, product_key varchar(50) NOT NULL);
    CREATE TABLE organization_products (org_id uuid NOT NULL, product_key varchar(50) NOT NULL);
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("the module catalog", () => {
  it("keeps Cockpit, Conducción, Peajes and Vencimientos out of every package, and out of the default", () => {
    for (const template of Object.values(MODULE_TEMPLATES)) {
      for (const hidden of ["cockpit", "conduccion", "peajes", "vencimientos"]) expect(template as readonly string[]).not.toContain(hidden);
    }
    expect(DEFAULT_MODULES).toEqual(MODULE_TEMPLATES.estandar);
  });

  it("builds the packages up: básico ⊂ estándar ⊂ completo, all made of known sections", () => {
    const { basico, estandar, completo } = MODULE_TEMPLATES;
    expect(basico.every((m) => (estandar as readonly string[]).includes(m))).toBe(true);
    expect(estandar.every((m) => (completo as readonly string[]).includes(m))).toBe(true);
    expect(completo.every((m) => (MODULE_KEYS as readonly string[]).includes(m))).toBe(true);
  });

  it("never offers the administration pages as grantable sections", () => {
    for (const admin of ["dispositivos", "sims", "apikeys", "ajustes", "equipo", "salud"]) {
      expect(MODULE_KEYS as readonly string[]).not.toContain(admin);
    }
  });

  it("gives owner and admin everything, others what was stored, and the default when nothing was", () => {
    expect(resolveModules("owner", [])).toEqual([...MODULE_KEYS]);
    expect(resolveModules("admin", ["mapa"])).toEqual([...MODULE_KEYS]);
    expect(resolveModules("viewer", ["mapa", "peajes"])).toEqual(["mapa", "peajes"]);
    expect(resolveModules("manager", null)).toEqual([...DEFAULT_MODULES]);
    expect(resolveModules("viewer", [])).toEqual([]);
  });

  it("drops unknown keys and repeats", () => {
    expect(sanitizeModules(["peajes", "mapa", "mapa", "hacker"])).toEqual(["mapa", "peajes"]);
  });
});

describe("the sections of a user", () => {
  it("a new client gets the standard package unless the admin chooses", async () => {
    const { orgId } = await registerOrganizationWithOwner({ orgName: "Gamonal", email: "o@gamonal.it", password: "supersecret1" });
    const standard = await createTeamMember({ orgId, name: "A", email: "a@c.it", password: "supersecret1", role: "viewer", productKeys: [] });
    expect(standard.modules).toEqual([...DEFAULT_MODULES]);
    const basic = await createTeamMember({ orgId, name: "B", email: "b@c.it", password: "supersecret1", role: "viewer", modules: [...MODULE_TEMPLATES.basico], productKeys: [] });
    expect(basic.modules).toEqual([...MODULE_TEMPLATES.basico]);
    expect(await getUserModules(basic.id)).toEqual([...MODULE_TEMPLATES.basico]);
  });

  it("the admin can change them, they apply at once and show in /me and in the team list", async () => {
    const { orgId, user } = await registerOrganizationWithOwner({ orgName: "Gamonal 2", email: "o2@gamonal.it", password: "supersecret1" });
    const client = await createTeamMember({ orgId, name: "DHL", email: "dhl@c.it", password: "supersecret1", role: "viewer", productKeys: [] });

    await updateTeamMemberModules(orgId, client.id, ["mapa", "conduccion"]);
    expect(await getUserModules(client.id)).toEqual(["mapa", "conduccion"]);
    expect((await getCurrentUser(client.id))?.modules).toEqual(["mapa", "conduccion"]);
    expect((await listTeamMembers(orgId, user.id, "owner")).find((m) => m.id === client.id)?.modules).toEqual(["mapa", "conduccion"]);
  });

  it("owner and admin always see everything, whatever was stored", async () => {
    const { orgId, user } = await registerOrganizationWithOwner({ orgName: "Gamonal 3", email: "o3@gamonal.it", password: "supersecret1" });
    const admin = await createTeamMember({ orgId, name: "Admin", email: "ad@c.it", password: "supersecret1", role: "admin", modules: ["mapa"], productKeys: [] });
    expect(await getUserModules(admin.id)).toEqual([...MODULE_KEYS]);
    expect(await getUserModules(user.id)).toEqual([...MODULE_KEYS]);
  });

  it("cannot be changed on a user of another organization", async () => {
    const a = await registerOrganizationWithOwner({ orgName: "Org A2", email: "a2@gamonal.it", password: "supersecret1" });
    const b = await registerOrganizationWithOwner({ orgName: "Org B2", email: "b2@gamonal.it", password: "supersecret1" });
    const victim = await createTeamMember({ orgId: b.orgId, name: "V", email: "v@c.it", password: "supersecret1", role: "viewer", productKeys: [] });
    expect(await updateTeamMemberModules(a.orgId, victim.id, ["peajes"])).toBeUndefined();
    expect(await getUserModules(victim.id)).toEqual([...DEFAULT_MODULES]);
  });

  it("is empty for a user that doesn't exist", async () => {
    expect(await getUserModules("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});
