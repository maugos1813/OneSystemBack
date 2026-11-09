import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Which flota a device belongs to, remembered briefly so the live channel doesn't ask the database for every position of every user. */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const fleet = await import("../../src/realtime/deviceFleet.js");
const vehicleService = await import("../../src/services/vehicle.service.js");
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000f001";
const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const OTHER = "00000000-0000-0000-0000-0000000000d2";
let vehicleId: string;

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20),
      fleet_group varchar(50), device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0,
      brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text,
      odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz,
      km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz, odometer_base_day_km double precision,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("DELETE FROM vehicles");
  const { rows } = await pg.query<{ id: string }>(`INSERT INTO vehicles (org_id, name, fleet_group, device_id) VALUES ('${ORG}', 'FV482KL', 'DHL', '${DEVICE}') RETURNING id`);
  vehicleId = rows[0]!.id;
  fleet.invalidateDeviceFleets();
});

describe("the flota of a device", () => {
  it("is the flota of its vehicle, and null when the device has no vehicle or the vehicle has no flota", async () => {
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBe("DHL");
    expect(await fleet.fleetGroupOfDevice(OTHER)).toBeNull();
    await pg.exec(`UPDATE vehicles SET fleet_group = NULL`);
    fleet.invalidateDeviceFleets();
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBeNull();
  });

  it("is remembered for a few seconds: a change made outside isn't seen until it expires", async () => {
    const t0 = 1_000_000;
    expect(await fleet.fleetGroupOfDevice(DEVICE, t0)).toBe("DHL");
    await pg.exec(`UPDATE vehicles SET fleet_group = 'UNIVEX'`);
    expect(await fleet.fleetGroupOfDevice(DEVICE, t0 + fleet.DEVICE_FLEET_TTL_MS - 1)).toBe("DHL");
    expect(await fleet.fleetGroupOfDevice(DEVICE, t0 + fleet.DEVICE_FLEET_TTL_MS + 1)).toBe("UNIVEX");
  });

  it("is looked up once for everyone asking at the same moment", async () => {
    const first = fleet.fleetGroupOfDevice(DEVICE);
    const second = fleet.fleetGroupOfDevice(DEVICE);
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual(["DHL", "DHL"]);
  });

  it("is forgotten at once when a vehicle is moved to another flota, so the restriction never lags", async () => {
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBe("DHL");
    await vehicleService.updateVehicle(ORG, vehicleId, { fleetGroup: "UNIVEX" });
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBe("UNIVEX");
  });

  it("is forgotten when the vehicle is deleted or a new one takes the device", async () => {
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBe("DHL");
    await vehicleService.deleteVehicle(ORG, vehicleId);
    expect(await fleet.fleetGroupOfDevice(DEVICE)).toBeNull();
    await vehicleService.createVehicle({ orgId: ORG, name: "Nuevo", fleetGroup: "DHL", deviceId: OTHER });
    expect(await fleet.fleetGroupOfDevice(OTHER)).toBe("DHL");
  });
});
