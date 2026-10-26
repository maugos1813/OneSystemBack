import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The remote lock of the vehicle: queueing, the moving-vehicle guard, delivery and the device's answer. */

const harness = vi.hoisted(() => ({ connected: false, sent: [] as Array<{ imei: string; text: string }> }));

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/tcp-server/connections.js", () => ({
  sendToDevice: (imei: string, frame: Buffer) => {
    if (!harness.connected) return false;
    // A Codec 12 frame: 8-byte header, codec/qty/type (3), size (4), then the text.
    harness.sent.push({ imei, text: frame.subarray(15, frame.length - 5).toString("ascii") });
    return true;
  },
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const service = await import("../../src/services/deviceCommand.service.js");
const { devices, positions, deviceCommands } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const USER = "00000000-0000-0000-0000-0000000000f1";
const FTC = "00000000-0000-0000-0000-0000000000d1";
const FMC = "00000000-0000-0000-0000-0000000000d2";
const NOW = new Date("2026-10-19T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

beforeAll(async () => {
  await pg.exec(`
    CREATE TYPE device_status AS ENUM ('unclaimed', 'active', 'disabled');
    CREATE TYPE device_source AS ENUM ('teltonika', 'radius_velocity');
    CREATE TABLE devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, imei varchar(20) NOT NULL UNIQUE,
      model varchar(50) NOT NULL DEFAULT 'FMB204', serial_number varchar(32), firmware varchar(32),
      status device_status NOT NULL DEFAULT 'unclaimed', source device_source NOT NULL DEFAULT 'teltonika',
      last_seen_at timestamptz, green_driving_since timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL, angle integer NOT NULL,
      satellites smallint, speed integer NOT NULL, priority smallint NOT NULL, io_data jsonb NOT NULL,
      PRIMARY KEY (id, ts)
    );
    CREATE TYPE device_command_kind AS ENUM ('immobilize', 'release', 'green_driving');
    CREATE TYPE device_command_status AS ENUM ('pending', 'sent', 'confirmed', 'failed', 'expired', 'cancelled');
    CREATE TABLE device_commands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, device_id uuid NOT NULL, user_id uuid,
      kind device_command_kind NOT NULL, command varchar(100) NOT NULL,
      status device_command_status NOT NULL DEFAULT 'pending', response text,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      sent_at timestamptz, answered_at timestamptz
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  harness.connected = false;
  harness.sent = [];
  await db.delete(deviceCommands);
  await db.delete(positions);
  await db.delete(devices);
  await db.insert(devices).values([
    { id: FTC, orgId: ORG, imei: "863738074476384", model: "FTC920", status: "active" },
    { id: FMC, orgId: ORG, imei: "860848088100319", model: "FMC003", status: "active" },
  ]);
});

async function reportSpeed(speed: number, ts: Date) {
  await db.insert(positions).values({ deviceId: FTC, ts, lat: 45, lng: 7, altitude: 0, angle: 0, satellites: 12, speed, priority: 0, ioData: {} });
}

describe("requestImmobilizer", () => {
  it("only works on a device of the organization whose model has the output wired up", async () => {
    await expect(service.requestImmobilizer(OTHER_ORG, USER, FTC, "lock", NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.requestImmobilizer(ORG, USER, FMC, "lock", NOW)).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(deviceCommands)).toHaveLength(0);
  });

  it("queues the order when the device isn't connected, with who gave it", async () => {
    const command = await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    expect(command).toMatchObject({ kind: "immobilize", command: "setdigout 1", status: "pending", userId: USER });
    expect(harness.sent).toEqual([]);
  });

  it("writes it to the device right away when it is connected", async () => {
    harness.connected = true;
    const command = await service.requestImmobilizer(ORG, USER, FTC, "unlock", NOW);
    expect(command).toMatchObject({ kind: "release", status: "sent" });
    expect(harness.sent).toEqual([{ imei: "863738074476384", text: "setdigout 0" }]);
  });

  it("refuses to lock a vehicle that is moving, but never refuses to unlock it", async () => {
    await reportSpeed(60, minutes(-1));
    await expect(service.requestImmobilizer(ORG, USER, FTC, "lock", NOW)).rejects.toMatchObject({ status: 409 });
    await expect(service.requestImmobilizer(ORG, USER, FTC, "unlock", NOW)).resolves.toMatchObject({ kind: "release" });
  });

  it("allows the lock when the last report is old or the vehicle is stopped", async () => {
    await reportSpeed(80, minutes(-10));
    await expect(service.requestImmobilizer(ORG, USER, FTC, "lock", NOW)).resolves.toMatchObject({ status: "pending" });
    await reportSpeed(0, minutes(-1));
    await expect(service.requestImmobilizer(ORG, USER, FTC, "lock", NOW)).resolves.toMatchObject({ status: "pending" });
  });

  it("replaces an order still waiting with the newer one", async () => {
    const first = await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    await service.requestImmobilizer(ORG, USER, FTC, "unlock", NOW);
    const [row] = await db.select().from(deviceCommands).where(eq(deviceCommands.id, first.id));
    expect(row).toMatchObject({ status: "cancelled" });
  });
});

describe("dispatchPendingCommands", () => {
  const device = { id: FTC, imei: "863738074476384" };

  it("delivers a waiting order when the device shows up", async () => {
    await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    harness.connected = true;
    await service.dispatchPendingCommands(device, minutes(1));
    expect(harness.sent).toEqual([{ imei: "863738074476384", text: "setdigout 1" }]);
    const [row] = await db.select().from(deviceCommands);
    expect(row).toMatchObject({ status: "sent" });
  });

  it("holds a lock back while the vehicle is moving and sends it once it stops", async () => {
    await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    harness.connected = true;
    await reportSpeed(50, minutes(1));
    await service.dispatchPendingCommands(device, minutes(1));
    expect(harness.sent).toEqual([]);
    await reportSpeed(0, minutes(2));
    await service.dispatchPendingCommands(device, minutes(2));
    expect(harness.sent).toHaveLength(1);
  });

  it("drops a lock that waited past its limit instead of firing it late", async () => {
    await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    harness.connected = true;
    await service.dispatchPendingCommands(device, minutes(6));
    expect(harness.sent).toEqual([]);
    const [row] = await db.select().from(deviceCommands);
    expect(row).toMatchObject({ status: "expired" });
  });

  it("keeps an unlock waiting much longer", async () => {
    await service.requestImmobilizer(ORG, USER, FTC, "unlock", NOW);
    harness.connected = true;
    await service.dispatchPendingCommands(device, minutes(45));
    expect(harness.sent).toHaveLength(1);
  });
});

describe("the device's answer", () => {
  const device = { id: FTC, imei: "863738074476384" };

  async function sendLock() {
    harness.connected = true;
    await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
  }

  it("confirms the order the device just took", async () => {
    await sendLock();
    await service.recordCommandResponse(FTC, "DOUT1:1 Timeout:INFINITY", minutes(1));
    const [row] = await db.select().from(deviceCommands);
    expect(row).toMatchObject({ status: "confirmed", response: "DOUT1:1 Timeout:INFINITY" });
  });

  it("marks it failed when the device says it did not understand", async () => {
    await sendLock();
    await service.recordCommandResponse(FTC, "Wrong command", minutes(1));
    const [row] = await db.select().from(deviceCommands);
    expect(row).toMatchObject({ status: "failed" });
  });

  it("ignores an answer when nothing was sent", async () => {
    await expect(service.recordCommandResponse(FTC, "OK", minutes(1))).resolves.toBeUndefined();
    expect(await db.select().from(deviceCommands)).toHaveLength(0);
  });

  it("closes an order the device took but never answered, when listing", async () => {
    await sendLock();
    expect((await service.listDeviceCommands(ORG, FTC, minutes(1)))[0]).toMatchObject({ status: "sent" });
    expect((await service.listDeviceCommands(ORG, FTC, minutes(10)))[0]).toMatchObject({ status: "failed" });
    expect(await service.listDeviceCommands(OTHER_ORG, FTC, minutes(10))).toEqual([]);
    void device;
  });
});

describe("requestGreenDriving", () => {
  it("only works on a device of the organization whose model has the parameters (not the FTC920, not the Radius ones)", async () => {
    await expect(service.requestGreenDriving(OTHER_ORG, USER, FMC, "enable", "accelerometer", NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.requestGreenDriving(ORG, USER, FTC, "enable", "accelerometer", NOW)).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(deviceCommands)).toHaveLength(0);
  });

  it("queues the setparam order with OneTrack's limits and the accelerometer as the source", async () => {
    const command = await service.requestGreenDriving(ORG, USER, FMC, "enable", "accelerometer", NOW);
    expect(command).toMatchObject({
      kind: "green_driving",
      status: "pending",
      command: "setparam 11000:1;11004:3;11005:3.5;11006:4;11007:1",
      userId: USER,
    });
    expect(service.greenDrivingCommand("enable", "gps")).toContain("11007:0");
    expect(service.greenDrivingCommand("disable")).toBe("setparam 11000:0");
  });

  it("writes it to the device right away when it is connected", async () => {
    harness.connected = true;
    await service.requestGreenDriving(ORG, USER, FMC, "enable", "accelerometer", NOW);
    expect(harness.sent).toEqual([{ imei: "860848088100319", text: "setparam 11000:1;11004:3;11005:3.5;11006:4;11007:1" }]);
  });

  it("starts counting the device's own events when it accepts, and stops when switched off", async () => {
    harness.connected = true;
    await service.requestGreenDriving(ORG, USER, FMC, "enable", "accelerometer", NOW);
    await service.recordCommandResponse(FMC, "Param values accepted", minutes(1));
    const [on] = await db.select().from(devices).where(eq(devices.id, FMC));
    expect(on?.greenDrivingSince?.toISOString()).toBe(minutes(1).toISOString());

    await service.requestGreenDriving(ORG, USER, FMC, "disable", "accelerometer", minutes(2));
    await service.recordCommandResponse(FMC, "Param values accepted", minutes(3));
    const [off] = await db.select().from(devices).where(eq(devices.id, FMC));
    expect(off?.greenDrivingSince).toBeNull();
  });

  it("does not switch it on when the device refuses", async () => {
    harness.connected = true;
    await service.requestGreenDriving(ORG, USER, FMC, "enable", "accelerometer", NOW);
    await service.recordCommandResponse(FMC, "Wrong parameter id", minutes(1));
    const [row] = await db.select().from(devices).where(eq(devices.id, FMC));
    expect(row?.greenDrivingSince).toBeNull();
    expect((await db.select().from(deviceCommands))[0]).toMatchObject({ status: "failed" });
  });

  it("is not cancelled by a lock order, and does not cancel one", async () => {
    const settings = await service.requestGreenDriving(ORG, USER, FMC, "enable", "accelerometer", NOW);
    await db.update(devices).set({ model: "FMB920" }).where(eq(devices.id, FTC));
    await service.requestImmobilizer(ORG, USER, FTC, "lock", NOW);
    const [row] = await db.select().from(deviceCommands).where(eq(deviceCommands.id, settings.id));
    expect(row).toMatchObject({ status: "pending" });
  });
});
