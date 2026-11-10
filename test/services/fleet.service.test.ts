import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const client = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { listFleetPictures, setFleetLogo, setFleetVehicles, FleetVehiclesError } = await import("../../src/services/fleet.service.js");
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
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid NOT NULL, fleet_group varchar(50)); ALTER TABLE vehicles ADD COLUMN out_of_service boolean NOT NULL DEFAULT false; ALTER TABLE vehicles ADD COLUMN out_of_service_at timestamptz;
    CREATE TABLE fleets (org_id uuid NOT NULL, name varchar(50) NOT NULL, logo text, logo_tag text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name));
  `);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE users, fleets, vehicles, organizations`);
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

describe("choosing by hand which vehicles a fleet has", () => {
  const V = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const groups = async () => (await pg.query<{ id: string; fleet_group: string | null }>(`SELECT id, fleet_group FROM vehicles ORDER BY id`)).rows.map((r) => r.fleet_group);

  beforeEach(async () => {
    await pg.exec(`
      INSERT INTO vehicles (id, org_id, fleet_group) VALUES
        ('${V(1)}','${O1}','ONE DRIVER EXPRESS'), ('${V(2)}','${O1}','ONE DRIVER EXPRESS'),
        ('${V(3)}','${O1}','ONE DRIVER SALUTE'), ('${V(4)}','${O1}', NULL), ('${V(5)}','${O2}', NULL);
    `);
  });

  it("puts exactly the chosen vehicles in the fleet: the new ones come in (leaving their old fleet) and the ones left out are freed", async () => {
    const result = await setFleetVehicles(O1, "ONE DRIVER EXPRESS", [V(2), V(3), V(4)]);
    expect(result).toEqual({ inFleet: 3, released: 1 });
    expect(await groups()).toEqual([null, "ONE DRIVER EXPRESS", "ONE DRIVER EXPRESS", "ONE DRIVER EXPRESS", null]);
  });

  it("can empty a fleet, and counts a vehicle given twice once", async () => {
    expect(await setFleetVehicles(O1, "ONE DRIVER EXPRESS", [])).toEqual({ inFleet: 0, released: 2 });
    expect((await groups()).slice(0, 2)).toEqual([null, null]);
    expect(await setFleetVehicles(O1, " ONE DRIVER SALUTE ", [V(4), V(4)])).toEqual({ inFleet: 2 - 1, released: 1 });
  });

  it("refuses a vehicle that is not of this organization, and changes nothing", async () => {
    await expect(setFleetVehicles(O1, "ONE DRIVER EXPRESS", [V(1), V(5)])).rejects.toBeInstanceOf(FleetVehiclesError);
    expect(await groups()).toEqual(["ONE DRIVER EXPRESS", "ONE DRIVER EXPRESS", "ONE DRIVER SALUTE", null, null]);
  });

  it("leaves other fleets' vehicles alone", async () => {
    await setFleetVehicles(O1, "ONE DRIVER SALUTE", [V(3)]);
    expect((await groups())[0]).toBe("ONE DRIVER EXPRESS");
  });
});
