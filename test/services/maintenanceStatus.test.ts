import { describe, expect, it } from "vitest";
import { addMonths, computePlanStatus, oemOdometerKm, trackerOdometerKm } from "../../src/services/maintenanceStatus.js";
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

  it("turns orange from 40 % left and red below 20 % left (6 000 and 3 000 km on a 15 000 km interval)", () => {
    expect(computePlanStatus(plan, 88999, NOW).state).toBe("ok"); // 6 001 left
    expect(computePlanStatus(plan, 89000, NOW).state).toBe("soon"); // 6 000 left
    expect(computePlanStatus(plan, 92000, NOW).state).toBe("soon"); // 3 000 left, exactly 20 %
    expect(computePlanStatus(plan, 92001, NOW).state).toBe("due"); // 2 999 left
  });

  it("on a 20 000 km service: orange with 8 000 km left, red with 3 999 or fewer", () => {
    const service = { intervalKm: 20000, intervalMonths: null, lastDoneAt: null, lastDoneKm: 100000 };
    expect(computePlanStatus(service, 111999, NOW)).toMatchObject({ state: "ok", kmRemaining: 8001 });
    expect(computePlanStatus(service, 112000, NOW)).toMatchObject({ state: "soon", kmRemaining: 8000 });
    expect(computePlanStatus(service, 116000, NOW)).toMatchObject({ state: "soon", kmRemaining: 4000 });
    expect(computePlanStatus(service, 116001, NOW)).toMatchObject({ state: "due", kmRemaining: 3999 });
    expect(computePlanStatus(service, 119999, NOW)).toMatchObject({ state: "due", kmRemaining: 1 });
  });

  it("is overdue only once the due km is passed, not at it", () => {
    expect(computePlanStatus(plan, 95000, NOW)).toMatchObject({ state: "due", kmRemaining: 0 });
    expect(computePlanStatus(plan, 95001, NOW)).toMatchObject({ state: "overdue", kmRemaining: -1 });
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

  it("is orange within 30 days, red within 7, and overdue after the date", () => {
    expect(computePlanStatus(plan, null, new Date("2026-10-18T12:00:00Z")).state).toBe("soon"); // 30 days left
    expect(computePlanStatus(plan, null, new Date("2026-11-09T12:00:00Z")).state).toBe("soon"); // 8 days left
    expect(computePlanStatus(plan, null, new Date("2026-11-10T12:00:00Z")).state).toBe("due"); // 7 days left
    expect(computePlanStatus(plan, null, new Date("2026-11-17T11:00:00Z")).state).toBe("due"); // due today
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

describe("oemOdometerKm", () => {
  it("is the car's own odometer, and nothing else: not the tracker's distance counter", () => {
    expect(oemOdometerKm({ "389": 85123, "16": 3200000 })).toBe(85123);
    expect(oemOdometerKm({ "16": 3200000 })).toBeNull();
    expect(oemOdometerKm({ "389": 0 })).toBeNull(); // the device reads the field but the car gave no mileage
    expect(oemOdometerKm({ "389": "x" })).toBeNull();
    expect(oemOdometerKm(null)).toBeNull();
  });
});

describe("maintenanceAlertMessage", () => {
  it("says what is left when the service is about to be due (red) too", () => {
    const due = maintenanceAlertMessage(
      "VAN-1",
      "Tagliando",
      { state: "due", dueKm: 150000, dueDate: null, kmRemaining: 2500, daysRemaining: null, usedFraction: 0.87 },
      "it",
    );
    expect(due).toContain("manutenzione in scadenza — Tagliando");
    expect(due).toContain("mancano");
  });

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
