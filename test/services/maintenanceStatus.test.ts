import { describe, expect, it } from "vitest";
import { addMonths, computePlanStatus, trackerOdometerKm } from "../../src/services/maintenanceStatus.js";
import { maintenanceAlertMessage } from "../../src/services/maintenance.service.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("addMonths", () => {
  it("adds calendar months and clamps to the end of a shorter month", () => {
    expect(addMonths(new Date("2026-01-15T10:00:00Z"), 12).toISOString()).toBe("2027-01-15T10:00:00.000Z");
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(addMonths(new Date("2026-11-30T00:00:00Z"), 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(addMonths(new Date("2026-10-17T00:00:00Z"), 24).toISOString()).toBe("2028-10-17T00:00:00.000Z");
  });
});

describe("computePlanStatus by km", () => {
  const plan = { intervalKm: 15000, intervalMonths: null, lastDoneAt: null, lastDoneKm: 80000 };

  it("is ok well before the due point", () => {
    const s = computePlanStatus(plan, 85000, NOW);
    expect(s).toMatchObject({ state: "ok", dueKm: 95000, kmRemaining: 10000, dueDate: null, daysRemaining: null });
    expect(s.usedFraction).toBeCloseTo(5000 / 15000);
  });

  it("is soon in the last 10 % of the interval (1 500 km here)", () => {
    expect(computePlanStatus(plan, 93499, NOW).state).toBe("ok");
    expect(computePlanStatus(plan, 93500, NOW).state).toBe("soon");
    expect(computePlanStatus(plan, 94999, NOW).state).toBe("soon");
  });

  it("is overdue only once the due km is passed, not at it", () => {
    expect(computePlanStatus(plan, 95000, NOW)).toMatchObject({ state: "soon", kmRemaining: 0 });
    expect(computePlanStatus(plan, 95001, NOW)).toMatchObject({ state: "overdue", kmRemaining: -1 });
  });

  it("uses a 500 km floor for the soon window on short intervals", () => {
    const short = { intervalKm: 2000, intervalMonths: null, lastDoneAt: null, lastDoneKm: 0 };
    expect(computePlanStatus(short, 1499, NOW).state).toBe("ok"); // 10 % would be 200 km
    expect(computePlanStatus(short, 1500, NOW).state).toBe("soon");
  });

  it("is unknown without an odometer reading or a baseline, never a false ok", () => {
    expect(computePlanStatus(plan, null, NOW).state).toBe("unknown");
    expect(computePlanStatus({ ...plan, lastDoneKm: null }, 90000, NOW).state).toBe("unknown");
  });
});

describe("computePlanStatus by time", () => {
  const plan = { intervalKm: null, intervalMonths: 12, lastDoneAt: new Date("2025-11-17T12:00:00Z"), lastDoneKm: null };

  it("counts days to the due date", () => {
    const s = computePlanStatus(plan, null, NOW);
    expect(s.dueDate?.toISOString()).toBe("2026-11-17T12:00:00.000Z");
    expect(s.daysRemaining).toBe(31);
    expect(s.state).toBe("ok");
  });

  it("is soon within 30 days and overdue after the date", () => {
    expect(computePlanStatus(plan, null, new Date("2026-10-18T12:00:00Z")).state).toBe("soon"); // 30 days left
    expect(computePlanStatus(plan, null, new Date("2026-11-17T11:00:00Z")).state).toBe("soon"); // due today
    expect(computePlanStatus(plan, null, new Date("2026-11-17T13:00:00Z"))).toMatchObject({ state: "overdue", daysRemaining: -1 });
  });

  it("works for a vehicle with no odometer at all", () => {
    expect(computePlanStatus(plan, null, daysAgo(0)).state).not.toBe("unknown");
  });
});

describe("computePlanStatus with both limits", () => {
  const plan = { intervalKm: 15000, intervalMonths: 12, lastDoneAt: new Date("2026-04-17T12:00:00Z"), lastDoneKm: 80000 };

  it("whichever comes first decides", () => {
    // km far from due, date far from due
    expect(computePlanStatus(plan, 82000, NOW).state).toBe("ok");
    // km overdue though the date is fine
    expect(computePlanStatus(plan, 96000, NOW).state).toBe("overdue");
    // km fine though the date has passed
    expect(computePlanStatus(plan, 82000, new Date("2027-05-01T00:00:00Z")).state).toBe("overdue");
  });

  it("falls back to the time limit alone when the odometer is unknown", () => {
    expect(computePlanStatus(plan, null, NOW)).toMatchObject({ state: "ok", kmRemaining: null });
  });

  it("reports the larger of the two used fractions", () => {
    const s = computePlanStatus(plan, 89000, NOW);
    expect(s.usedFraction).toBeCloseTo(9000 / 15000);
  });
});

describe("trackerOdometerKm", () => {
  it("converts the tracker counter (metres) to km", () => {
    expect(trackerOdometerKm({ "16": 152340000 })).toBe(152340);
    expect(trackerOdometerKm({ "16": "1500" })).toBe(2);
    expect(trackerOdometerKm({ "16": 0 })).toBe(0);
  });

  it("prefers the OEM mileage read through OBD, which is the car's real odometer", () => {
    expect(trackerOdometerKm({ "16": 3200000, "389": 85123 })).toBe(85123);
  });

  it("is null when nothing is reported", () => {
    expect(trackerOdometerKm({ "66": 12000 })).toBeNull();
    expect(trackerOdometerKm({})).toBeNull();
    expect(trackerOdometerKm(null)).toBeNull();
  });
});

describe("maintenanceAlertMessage", () => {
  it("says overdue or what is left", () => {
    const base = { dueKm: 95000, dueDate: null };
    expect(maintenanceAlertMessage("VAN-1", "Aceite", { ...base, state: "overdue", kmRemaining: -10, daysRemaining: null, usedFraction: 1.1 })).toBe(
      "VAN-1: mantenimiento vencido — Aceite",
    );
    const soon = maintenanceAlertMessage("VAN-1", "Aceite", { ...base, state: "soon", kmRemaining: 320, daysRemaining: 12, usedFraction: 0.9 });
    expect(soon).toContain("próximo — Aceite");
    expect(soon).toContain("320");
    expect(soon).toContain("12 días");
  });
});
