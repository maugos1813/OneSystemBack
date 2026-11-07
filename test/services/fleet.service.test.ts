import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const client = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { listFleetPictures, setFleetLogo } = await import("../../src/services/fleet.service.js");
const pg = client.__pg;

const O1 = "11111111-1111-4111-8111-111111111111";
const O2 = "22222222-2222-4222-8222-222222222222";
const BIG = "data:image/png;base64,BIG";
const SMALL = "data:image/png;base64,SMALL";
const PHOTO = "data:image/png;base64,PHOTO";

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, email varchar(255) NOT NULL, logo text, allowed_area varchar(50));
    CREATE TABLE fleets (org_id uuid NOT NULL, name varchar(50) NOT NULL, logo text, logo_tag text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name));
  `);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE users, fleets, organizations`);
  await pg.exec(`INSERT INTO organizations VALUES ('${O1}'), ('${O2}')`);
  await pg.exec(`
    INSERT INTO users (org_id, email, logo, allowed_area) VALUES
      ('${O1}','dueno@x.it',NULL,NULL),
      ('${O1}','express@x.it','${PHOTO}','ONE DRIVER EXPRESS'),
      ('${O1}','salute@x.it',NULL,'ONE DRIVER SALUTE'),
      ('${O1}','vacio@x.it',NULL,''),
      ('${O2}','otra@x.it',NULL,'OTRA');
  `);
});

describe("a fleet is a team account limited to it, and its picture is that account's photo", () => {
  it("lists the fleets of the accounts, with the account's photo when there is nothing better", async () => {
    expect(await listFleetPictures(O1)).toEqual([
      { name: "ONE DRIVER EXPRESS", tag: PHOTO },
      { name: "ONE DRIVER SALUTE", tag: null },
    ]);
  });

  it("never mixes in another client's fleets", async () => {
    expect((await listFleetPictures(O2)).map((f) => f.name)).toEqual(["OTRA"]);
  });

  it("narrows the answer to one fleet for an account limited to it", async () => {
    expect((await listFleetPictures(O1, "ONE DRIVER SALUTE")).map((f) => f.name)).toEqual(["ONE DRIVER SALUTE"]);
    expect(await listFleetPictures(O1, "NOPE")).toEqual([]);
  });

  it("prefers the small copy kept with the fleet, then the full picture, then the account's photo", async () => {
    await setFleetLogo(O1, "ONE DRIVER EXPRESS", BIG, SMALL);
    expect((await listFleetPictures(O1)).find((f) => f.name === "ONE DRIVER EXPRESS")?.tag).toBe(SMALL);
    await setFleetLogo(O1, " ONE DRIVER EXPRESS ", BIG);
    expect((await listFleetPictures(O1)).find((f) => f.name === "ONE DRIVER EXPRESS")?.tag).toBe(BIG);
    await setFleetLogo(O1, "ONE DRIVER EXPRESS", null);
    expect((await listFleetPictures(O1)).find((f) => f.name === "ONE DRIVER EXPRESS")?.tag).toBe(PHOTO);
    expect((await pg.query(`SELECT count(*)::int n FROM fleets`)).rows).toEqual([{ n: 0 }]);
  });

  it("keeps pictures per client", async () => {
    await setFleetLogo(O1, "OTRA", BIG, SMALL);
    expect((await listFleetPictures(O2)).find((f) => f.name === "OTRA")?.tag).toBeNull();
  });
});
