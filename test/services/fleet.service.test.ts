import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
const created = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../src/services/teamUser.service.js", () => ({
  createTeamMember: async (input: unknown) => {
    created.calls.push(input);
    return { id: "new" };
  },
}));

const client = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { listFleetDetails, listFleetPictures, setFleetLogo, createFleetAdmin } = await import("../../src/services/fleet.service.js");
const pg = client.__pg;

const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const PNG = "data:image/png;base64,AAAA";

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT 'v', fleet_group varchar(50));
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL, role text NOT NULL DEFAULT 'viewer', allowed_area varchar(50));
    CREATE TABLE fleets (org_id uuid NOT NULL, name varchar(50) NOT NULL, logo text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name));
  `);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  created.calls.length = 0;
  await pg.exec(`TRUNCATE vehicles, users, fleets, organizations`);
  await pg.exec(`INSERT INTO organizations VALUES ('${O1}'), ('${O2}')`);
  await pg.exec(`
    INSERT INTO vehicles (org_id, fleet_group) VALUES ('${O1}','DHL'), ('${O1}','DHL'), ('${O1}','UNIVEX'), ('${O1}', NULL), ('${O2}','OTRA');
    INSERT INTO users (org_id, name, email, role, allowed_area) VALUES
      ('${O1}','Dueño','dueno@x.it','owner',NULL),
      ('${O1}','Admin DHL','dhl@x.it','manager','DHL'),
      ('${O1}','Piazza','p@x.it','manager','PIAZZA'),
      ('${O1}','Vacío','v@x.it','viewer','');
  `);
});

describe("the fleets of a client, from what the system already has", () => {
  it("lists the fleets of its vehicles and the ones its users are limited to, with their administrators", async () => {
    const list = await listFleetDetails(O1);
    expect(list.map((f) => f.name)).toEqual(["DHL", "PIAZZA", "UNIVEX"]);
    const dhl = list.find((f) => f.name === "DHL")!;
    expect(dhl.vehicles).toBe(2);
    expect(dhl.admins.map((a) => a.email)).toEqual(["dhl@x.it"]);
    const piazza = list.find((f) => f.name === "PIAZZA")!;
    expect(piazza).toMatchObject({ vehicles: 0, logo: null });
    expect(piazza.admins.map((a) => a.email)).toEqual(["p@x.it"]);
    expect(list.find((f) => f.name === "UNIVEX")!.admins).toEqual([]);
  });

  it("never mixes in another client's fleets", async () => {
    expect((await listFleetDetails(O2)).map((f) => f.name)).toEqual(["OTRA"]);
  });

  it("narrows the answer to one fleet for an account limited to it", async () => {
    expect((await listFleetPictures(O1, "DHL")).map((f) => f.name)).toEqual(["DHL"]);
    expect(await listFleetPictures(O1, "NOPE")).toEqual([]);
  });

  it("keeps a picture for a fleet, replaces it, and forgets it when removed", async () => {
    await setFleetLogo(O1, " DHL ", PNG);
    expect((await listFleetPictures(O1)).find((f) => f.name === "DHL")?.logo).toBe(PNG);
    await setFleetLogo(O1, "DHL", "data:image/png;base64,BBBB");
    expect((await listFleetPictures(O1)).find((f) => f.name === "DHL")?.logo).toBe("data:image/png;base64,BBBB");
    await setFleetLogo(O1, "DHL", null);
    expect((await listFleetPictures(O1)).find((f) => f.name === "DHL")?.logo).toBeNull();
    expect((await pg.query(`SELECT count(*)::int n FROM fleets`)).rows).toEqual([{ n: 0 }]);
  });

  it("lists a fleet that only has a picture (no vehicle, no user yet) and keeps pictures per client", async () => {
    await setFleetLogo(O1, "NUEVA", PNG);
    expect((await listFleetDetails(O1)).map((f) => f.name)).toContain("NUEVA");
    expect((await listFleetDetails(O2)).map((f) => f.name)).not.toContain("NUEVA");
  });
});

describe("the account that administers a fleet", () => {
  it("is a manager limited to that fleet, in that client", async () => {
    await createFleetAdmin(O1, " UNIVEX ", { name: "Ana", email: "ana@x.it", password: "12345678", language: "it" });
    expect(created.calls).toEqual([
      { orgId: O1, name: "Ana", email: "ana@x.it", password: "12345678", role: "manager", allowedArea: "UNIVEX", language: "it" },
    ]);
  });
});
