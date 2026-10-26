import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** claimDevice against an in-memory Postgres holding the real `devices` table shape. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { claimDevice, isValidImei } = await import("../../src/services/device.service.js");
const { devices } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const FMC003 = "860848088107876";

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE device_status AS ENUM ('unclaimed', 'active', 'disabled');
    CREATE TYPE device_source AS ENUM ('teltonika', 'radius_velocity');
    CREATE TABLE devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, imei varchar(20) NOT NULL UNIQUE,
      model varchar(50) NOT NULL DEFAULT 'FMB204', serial_number varchar(32), firmware varchar(32),
      status device_status NOT NULL DEFAULT 'unclaimed', source device_source NOT NULL DEFAULT 'teltonika',
      last_seen_at timestamptz, green_driving_since timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await clientModule.__pg.close();
});

beforeEach(async () => {
  await db.delete(devices);
});

describe("isValidImei", () => {
  it("accepts real IMEIs and rejects a wrong digit, wrong length or non-digits", () => {
    expect(isValidImei(FMC003)).toBe(true);
    expect(isValidImei("353742379862535")).toBe(true);
    expect(isValidImei("860848088107877")).toBe(false);
    expect(isValidImei("86084808810787")).toBe(false);
    expect(isValidImei("8608480881078760")).toBe(false);
    expect(isValidImei("86084808810787a")).toBe(false);
    expect(isValidImei("")).toBe(false);
  });
});

describe("claimDevice", () => {
  it("registers a valid IMEI that never connected, straight into the organization", async () => {
    const device = await claimDevice(ORG, FMC003, "FMC003");
    expect(device).toMatchObject({ imei: FMC003, orgId: ORG, status: "active", model: "FMC003", lastSeenAt: null });
    expect(await db.select().from(devices)).toHaveLength(1);
  });

  it("uses the default model when none is given", async () => {
    expect(await claimDevice(ORG, FMC003)).toMatchObject({ model: "FMB204" });
  });

  it("takes over an unclaimed device that already connected, setting the model", async () => {
    await db.insert(devices).values({ imei: FMC003, lastSeenAt: new Date("2026-10-17T10:00:00Z") });
    const device = await claimDevice(ORG, FMC003, "FMC003");
    expect(device).toMatchObject({ orgId: ORG, status: "active", model: "FMC003" });
    expect(device!.lastSeenAt).toEqual(new Date("2026-10-17T10:00:00Z"));
    expect(await db.select().from(devices)).toHaveLength(1);
  });

  it("refuses a device that belongs to another organization, and leaves it alone", async () => {
    await db.insert(devices).values({ imei: FMC003, orgId: OTHER, status: "active" });
    expect(await claimDevice(ORG, FMC003, "FMC003")).toBeUndefined();
    const [row] = await db.select().from(devices).where(eq(devices.imei, FMC003));
    expect(row).toMatchObject({ orgId: OTHER, model: "FMB204" });
  });

  it("claiming it again by the same organization does nothing and creates no duplicate", async () => {
    await claimDevice(ORG, FMC003);
    expect(await claimDevice(ORG, FMC003)).toBeUndefined();
    expect(await db.select().from(devices)).toHaveLength(1);
  });

  it("does not invent a device from an invalid IMEI, but still takes over an existing odd one", async () => {
    expect(await claimDevice(ORG, "860848088107877")).toBeUndefined();
    expect(await claimDevice(ORG, "not-an-imei-123")).toBeUndefined();
    expect(await db.select().from(devices)).toHaveLength(0);

    await db.insert(devices).values({ imei: "rv-12345" });
    expect(await claimDevice(ORG, "rv-12345")).toMatchObject({ orgId: ORG });
  });

  it("the tracker's first connection then finds the registered row instead of creating another", async () => {
    await claimDevice(ORG, FMC003, "FMC003");
    const { findOrCreateDeviceByImei } = await import("../../src/services/device.service.js");
    const found = await findOrCreateDeviceByImei(FMC003);
    expect(found).toMatchObject({ orgId: ORG, model: "FMC003" });
    expect(await db.select().from(devices)).toHaveLength(1);
  });
});
