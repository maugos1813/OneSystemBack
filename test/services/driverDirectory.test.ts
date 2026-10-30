import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The copy of Gamonal Driver's drivers and services: what the sync writes, drops, and what "who has the vehicle now" picks. */

const ORG = "00000000-0000-0000-0000-00000000000a";

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/config/env.js", () => ({
  env: {
    DRIVER_API_URL: "https://driver.test/api/",
    DRIVER_INTEGRATION_KEY: "k".repeat(40),
    DRIVER_ORG_ID: "00000000-0000-0000-0000-00000000000a",
  },
}));
vi.mock("../../src/config/logger.js", () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const dir = await import("../../src/services/driverDirectory.service.js");
const { sameName } = await import("../../src/services/driverBeacon.service.js");
const pg = clientModule.__pg;

const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const uso = (servicioId: string, choferId: string, placa: string, desde: string, hasta: string | null, extra: object = {}) => ({
  servicioId, choferId, placa, placaFinal: null, desde, hasta, declarada: true, estado: "CONSEGNATO", ...extra,
});
const choferes = [
  { id: "d1", nombre: "Marco Rossi", telefono: " +39 333 1234567 ", activo: true, vehiculoHabitual: "gz 048 nr" },
  { id: "d2", nombre: "Anna Blu", telefono: null, activo: false, vehiculoHabitual: null },
];

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    INSERT INTO organizations VALUES ('${ORG}');
    CREATE TABLE driver_people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, external_id varchar(64) NOT NULL, name varchar(150) NOT NULL,
      phone varchar(40), active boolean NOT NULL DEFAULT true, habitual_plate varchar(20), synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, external_id));
    CREATE TABLE driver_usages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, external_id varchar(64) NOT NULL, driver_external_id varchar(64) NOT NULL,
      plate varchar(20) NOT NULL, final_plate varchar(20), starts_at timestamptz NOT NULL, ends_at timestamptz, declared boolean NOT NULL DEFAULT false,
      status varchar(20) NOT NULL, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, external_id));
  `);
});

describe("syncing the Driver's drivers and services", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const answer = (usos: unknown[]) =>
    fetchMock.mockImplementation(async (url: string) => (url.includes("/choferes") ? reply({ choferes }) : reply({ usos })));

  it("asks the Driver with the service key, and keeps clean names, phones and plates", async () => {
    answer([uso("s1", "d1", "GZ048NR", hoursAgo(5), hoursAgo(1))]);
    expect(await dir.syncDriverDirectory(3)).toEqual({ people: 2, usages: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://driver.test/api/integraciones/onesystec/choferes");
    expect((init as RequestInit).headers).toEqual({ "X-Integration-Key": "k".repeat(40) });

    const got = await dir.listVehicleUsages(ORG, "gz 048 nr", new Date(Date.now() - 24 * 3_600_000), new Date());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ driver: { name: "Marco Rossi", phone: "+393331234567".replace(/ /g, "").replace("+39", "+39") }, declared: true, switched: false });
  });

  it("drops a service the Driver no longer lists, and updates one it changed", async () => {
    answer([uso("s1", "d1", "GZ048NR", hoursAgo(5), hoursAgo(1)), uso("s2", "d2", "GZ048NR", hoursAgo(30), hoursAgo(26))]);
    await dir.syncDriverDirectory(3);
    expect(await dir.listVehicleUsages(ORG, "GZ048NR", new Date(Date.now() - 48 * 3_600_000), new Date())).toHaveLength(2);

    // s2 was cancelled in the Driver; s1 now ends later and has moved to another van.
    answer([uso("s1", "d1", "EX030XG", hoursAgo(5), hoursAgo(0.5), { placaFinal: "GZ048NR" })]);
    await dir.syncDriverDirectory(3);
    const here = await dir.listVehicleUsages(ORG, "GZ048NR", new Date(Date.now() - 48 * 3_600_000), new Date());
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ switched: true, to: expect.any(String) });
    expect(await dir.listVehicleUsages(ORG, "EX030XG", new Date(Date.now() - 48 * 3_600_000), new Date())).toHaveLength(1);
  });

  it("does not touch services older than the window it asked for", async () => {
    await pg.exec(`INSERT INTO driver_usages (org_id, external_id, driver_external_id, plate, starts_at, ends_at, status, synced_at)
      VALUES ('${ORG}', 'old', 'd1', 'GZ048NR', now() - interval '40 days', now() - interval '40 days' + interval '5 hours', 'CONSEGNATO', now() - interval '40 days')`);
    answer([]);
    await dir.syncDriverDirectory(3);
    const old = await dir.listVehicleUsages(ORG, "GZ048NR", new Date(Date.now() - 41 * 86_400_000), new Date(Date.now() - 39 * 86_400_000));
    expect(old).toHaveLength(1);
  });

  it("leaves the copy as it was when the Driver fails or answers something unexpected", async () => {
    answer([uso("keep", "d1", "ZZ999ZZ", hoursAgo(2), hoursAgo(1))]);
    await dir.syncDriverDirectory(3);
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    await expect(dir.syncDriverDirectory(3)).rejects.toThrow("503");
    fetchMock.mockImplementation(async () => reply({ nope: true }));
    await expect(dir.syncDriverDirectory(3)).rejects.toThrow();
    expect(await dir.listVehicleUsages(ORG, "ZZ999ZZ", new Date(Date.now() - 6 * 3_600_000), new Date())).toHaveLength(1);
    // And syncSafely never throws.
    await expect(dir.syncSafely(3)).resolves.toBeUndefined();
  });
});

describe("who has the vehicle at a moment", () => {
  const u = (from: string, to: string | null, name: string) => ({
    driver: { name, phone: null, active: true }, from, to, declared: true, switched: false, status: "CONSEGNATO",
  });
  const at = new Date("2026-10-28T10:00:00Z");

  it("picks the service that contains the moment, the latest started when two overlap", () => {
    const got = dir.currentUsage([u("2026-10-28T06:00:00Z", "2026-10-28T14:00:00Z", "A"), u("2026-10-28T09:00:00Z", "2026-10-28T12:00:00Z", "B")], at);
    expect(got?.driver.name).toBe("B");
  });

  it("falls back to the driver who just finished, but not to one from long ago", () => {
    expect(dir.currentUsage([u("2026-10-28T05:00:00Z", "2026-10-28T08:30:00Z", "A")], at)?.driver.name).toBe("A");
    expect(dir.currentUsage([u("2026-10-28T01:00:00Z", "2026-10-28T04:00:00Z", "A")], at)).toBeNull();
  });

  it("takes a service without end time to last twelve hours", () => {
    expect(dir.currentUsage([u("2026-10-28T02:00:00Z", null, "A")], at)?.driver.name).toBe("A");
    expect(dir.currentUsage([u("2026-10-27T10:00:00Z", null, "A")], at)).toBeNull();
  });

  it("cleans phones for a tel: link and drops what is not a number", () => {
    expect(dir.cleanPhone(" +39 333 123-4567 ")).toBe("+393331234567");
    expect(dir.cleanPhone("0039 06 1234567")).toBe("0039061234567");
    expect(dir.cleanPhone("n/d")).toBeNull();
    expect(dir.cleanPhone(null)).toBeNull();
  });

  it("matches a name written in the other order, with accents or extra spaces", () => {
    expect(sameName("Rossi Marco", "marco  rossi")).toBe(true);
    expect(sameName("José Núñez", "Jose Nunez")).toBe(true);
    expect(sameName("Marco Rossi", "Marco Bianchi")).toBe(false);
  });
});
