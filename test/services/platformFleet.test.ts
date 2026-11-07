import { beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ orgs: [] as unknown[], vehicles: [] as unknown[], devices: [] as unknown[] }));
const latest = vi.hoisted(() => ({ byDevice: {} as Record<string, unknown> }));

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  return {
    db: {
      select: () => ({
        from: async (table: unknown) =>
          table === schema.organizations ? data.orgs : table === schema.vehicles ? data.vehicles : table === schema.devices ? data.devices : [],
      }),
    },
  };
});
vi.mock("../../src/services/position.service.js", () => ({ getLatestPosition: async (deviceId: string) => latest.byDevice[deviceId] }));

const { getPlatformFleet } = await import("../../src/services/platform.service.js");

const at = new Date("2026-11-07T10:00:00Z");
const dev = (id: string, orgId: string | null, imei: string) => ({ id, orgId, imei, model: "FMC003", createdAt: at, status: "active", source: "teltonika" });

describe("getPlatformFleet", () => {
  beforeEach(() => {
    data.orgs = [
      { id: "o1", name: "GamonalTrasporti" },
      { id: "o2", name: "Piazza" },
    ];
    data.vehicles = [{ id: "v1", orgId: "o1", name: "AB123CD", plate: "AB123CD", fleetGroup: "DHL", deviceId: "d1" }];
    data.devices = [dev("d1", "o1", "111"), dev("d2", "o2", "222"), dev("d3", null, "333")];
    latest.byDevice = { d1: { lat: 1 }, d2: { lat: 2 }, d3: { lat: 3 } };
  });

  it("lists every vehicle with its client's name, and its latest position by vehicle id", async () => {
    const fleet = await getPlatformFleet();
    const v1 = fleet.vehicles.find((v) => v.id === "v1")!;
    expect(v1).toMatchObject({ fleetGroup: "GamonalTrasporti", orgName: "GamonalTrasporti" });
    expect(fleet.positions["v1"]).toEqual({ lat: 1 });
  });

  it("shows every device that has no vehicle, claimed or not, so none is ever missing", async () => {
    const fleet = await getPlatformFleet();
    expect(fleet.vehicles.map((v) => v.id).sort()).toEqual(["d2", "d3", "v1"]);
    const claimed = fleet.vehicles.find((v) => v.id === "d2")!;
    expect(claimed).toMatchObject({ deviceId: "d2", fleetGroup: "Piazza", name: "Sin vehículo · 222" });
    const unclaimed = fleet.vehicles.find((v) => v.id === "d3")!;
    expect(unclaimed).toMatchObject({ deviceId: "d3", fleetGroup: "Sin cliente", orgId: "" });
    expect(fleet.positions).toEqual({ v1: { lat: 1 }, d2: { lat: 2 }, d3: { lat: 3 } });
    expect(fleet.devices).toHaveLength(3);
  });

  it("leaves out the position of a device that has never reported", async () => {
    latest.byDevice = { d1: { lat: 1 } };
    const fleet = await getPlatformFleet();
    expect(Object.keys(fleet.positions)).toEqual(["v1"]);
  });
});
