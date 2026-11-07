import { describe, expect, it } from "vitest";
import {
  deviceFindings,
  isDigestDue,
  isOutsideItaly,
  romeTodayAt,
  securityDigestPushMessage,
  securityPushMessage,
  STATE_TYPES,
  TYPE_INFO,
  type DeviceContext,
} from "../../src/services/platformSecurity.js";

const NOW = new Date("2026-11-07T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hours = (n: number) => minutes(n * 60);

const base = (over: Partial<DeviceContext> = {}): DeviceContext => ({
  device: { id: "d1", imei: "860000000000001", orgId: "o1", lastSeenAt: minutes(1), model: "FMC003" },
  orgName: "GamonalTrasporti",
  vehicleName: "AB123CD",
  position: { lat: 45.4, lng: 9.1, speed: 0, ioData: { "66": 12500, "239": 0 } },
  alarms: new Map(),
  now: NOW,
  ...over,
});
const types = (ctx: DeviceContext) => deviceFindings(ctx).map((f) => f.type);

describe("what OneSystec watches on every device", () => {
  it("says nothing about a healthy device", () => {
    expect(deviceFindings(base())).toEqual([]);
  });

  it("raises the tracker's own alarms as urgent, naming the client and the vehicle", () => {
    const alarms = new Map([
      ["unplug_change", { payload: { "252": 1 }, ts: minutes(2) }],
      ["jamming_change", { payload: { "249": 1 }, ts: minutes(2) }],
      ["towing_change", { payload: { "246": 1 }, ts: minutes(2) }],
      ["crash_change", { payload: { "247": 3 }, ts: minutes(2) }],
    ]);
    const found = deviceFindings(base({ alarms }));
    expect(found.map((f) => f.type).sort()).toEqual(["crash", "jamming", "towing", "unplug"]);
    for (const f of found) {
      expect(TYPE_INFO[f.type].severity).toBe("urgent");
      expect(f.subject).toBe("GamonalTrasporti · AB123CD");
      expect(f.key).toBe(`${f.type}:d1`);
    }
  });

  it("does not raise an alarm that cleared", () => {
    const alarms = new Map([["unplug_change", { payload: { "252": 0 }, ts: minutes(2) }]]);
    expect(types(base({ alarms }))).toEqual([]);
  });

  it("flags a moving vehicle whose tracker has no vehicle power, but never a parked one", () => {
    const moving = base({ position: { lat: 45, lng: 9, speed: 40, ioData: { "66": 0 } } });
    expect(types(moving)).toContain("gps_no_power");
    const parked = base({ position: { lat: 45, lng: 9, speed: 0, ioData: { "66": 0 } } });
    expect(types(parked)).not.toContain("gps_no_power");
  });

  it("flags a tracker silent for 15 minutes after it was moving", () => {
    const ctx = base({
      device: { id: "d1", imei: "1", orgId: "o1", lastSeenAt: minutes(40), model: "FMC003" },
      position: { lat: 45, lng: 9, speed: 50, ioData: { "66": 12000 } },
    });
    expect(types(ctx)).toContain("gps_silent");
  });

  it("puts a long silence in the daily email, unless it was parked with the engine off or is long decommissioned", () => {
    const silent = (lastSeen: Date, ioData: Record<string, number>, speed = 0) =>
      base({ device: { id: "d1", imei: "1", orgId: "o1", lastSeenAt: lastSeen, model: "FMC003" }, position: { lat: 45, lng: 9, speed, ioData } });
    expect(types(silent(hours(5), { "66": 12000 }))).toContain("device_silent");
    expect(types(silent(hours(5), { "66": 12000, "239": 0 }))).not.toContain("device_silent");
    expect(types(silent(hours(24 * 10), { "66": 12000 }))).not.toContain("device_silent");
    expect(TYPE_INFO.device_silent.severity).toBe("digest");
  });

  it("flags an unknown device that is connecting, once, and only while it is recent", () => {
    const unknown = (lastSeen: Date | null) =>
      base({ device: { id: "dx", imei: "860111", orgId: null, lastSeenAt: lastSeen, model: "FMB204" }, orgName: null, vehicleName: null });
    const [finding] = deviceFindings(unknown(minutes(3)));
    expect(finding).toMatchObject({ type: "unknown_device", subject: "Sin cliente · IMEI 860111", key: "unknown_device:dx" });
    expect(TYPE_INFO.unknown_device).toMatchObject({ severity: "urgent", reminders: false });
    expect(deviceFindings(unknown(hours(48)))).toEqual([]);
    expect(deviceFindings(unknown(null))).toEqual([]);
  });

  it("flags a claimed device that reports with no vehicle", () => {
    expect(types(base({ vehicleName: null }))).toContain("device_unassigned");
  });

  it("flags a nearly dead internal battery only when the vehicle's power is gone too", () => {
    const withBattery = (io: Record<string, number>) => base({ position: { lat: 45, lng: 9, speed: 0, ioData: io } });
    expect(types(withBattery({ "66": 0, "67": 3400 }))).toContain("battery_unpowered");
    expect(types(withBattery({ "66": 12000, "67": 3400 }))).not.toContain("battery_unpowered");
    expect(types(withBattery({ "66": 0, "67": 4100 }))).not.toContain("battery_unpowered");
  });

  it("flags a recent tracking gap", () => {
    const alarms = new Map([["tracking_gap", { payload: { from: "x" }, ts: minutes(30) }]]);
    expect(types(base({ alarms }))).toContain("tracking_gap");
  });

  it("flags a device far from Italy, and not one without a GPS fix", () => {
    expect(types(base({ position: { lat: 40.4, lng: -3.7, speed: 0, ioData: {} } }))).toContain("abroad");
    expect(types(base({ position: { lat: 0, lng: 0, speed: 0, ioData: {} } }))).not.toContain("abroad");
    expect(isOutsideItaly(45.4, 9.1)).toBe(false);
    expect(isOutsideItaly(52.5, 13.4)).toBe(true);
  });

  it("makes the down-device alerts repeat, and says the one-offs once", () => {
    for (const type of ["unplug", "jamming", "towing", "crash", "gps_no_power", "gps_silent"] as const) {
      expect(TYPE_INFO[type]).toMatchObject({ severity: "urgent", reminders: true, state: true });
    }
    expect(TYPE_INFO.immobilizer).toMatchObject({ severity: "urgent", reminders: false, state: false });
    expect(STATE_TYPES).not.toContain("immobilizer");
    expect(STATE_TYPES).not.toContain("new_user");
    expect(STATE_TYPES).not.toContain("login_failed");
  });
});

describe("the urgent push", () => {
  it("is urgent, lists the first four and counts the rest", () => {
    const msg = securityPushMessage(["a", "b", "c", "d", "e", "f"], false);
    expect(msg.urgent).toBe(true);
    expect(msg.title).toContain("Seguridad OneSystec (6)");
    expect(msg.body).toBe("a\nb\nc\nd\n+2 más");
  });
  it("says it is a reminder", () => {
    expect(securityPushMessage(["a"], true).title).toContain("RECORDATORIO");
  });
});

describe("the daily summary without email", () => {
  it("is one quiet push with the count and the first lines", () => {
    const msg = securityDigestPushMessage(["a", "b", "c", "d", "e"]);
    expect(msg.urgent).toBeUndefined();
    expect(msg.title).toBe("Resumen de seguridad OneSystec (5)");
    expect(msg.body).toBe("a\nb\nc\nd\n+1 más");
  });
});

describe("the daily email", () => {
  it("is due from 08:00 in Rome, once a day (winter UTC+1, summer UTC+2)", () => {
    expect(romeTodayAt(new Date("2026-11-07T10:00:00Z"), 8).toISOString()).toBe("2026-11-07T07:00:00.000Z");
    expect(romeTodayAt(new Date("2026-07-07T10:00:00Z"), 8).toISOString()).toBe("2026-07-07T06:00:00.000Z");
    expect(isDigestDue(new Date("2026-11-07T06:59:00Z"), null)).toBe(false);
    expect(isDigestDue(new Date("2026-11-07T07:01:00Z"), null)).toBe(true);
    expect(isDigestDue(new Date("2026-11-07T09:00:00Z"), new Date("2026-11-07T07:05:00Z"))).toBe(false);
    expect(isDigestDue(new Date("2026-11-08T07:01:00Z"), new Date("2026-11-07T07:05:00Z"))).toBe(true);
  });
});
