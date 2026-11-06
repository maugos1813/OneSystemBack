import { describe, expect, it } from "vitest";
import {
  gpsNoPowerMessage,
  gpsSilentMessage,
  isReminderDue,
  isRunningWithoutPower,
  isSilentWhileMoving,
  REMINDER_MAX_AGE_MS,
} from "../../src/services/gpsDisconnect.js";
import { urgentPushMessage } from "../../src/services/push.service.js";

const at = (iso: string) => new Date(iso);

describe("isRunningWithoutPower", () => {
  it("is true when the vehicle moves and the tracker reports 0 V of external power", () => {
    expect(isRunningWithoutPower({ speed: 95, ioData: { "66": 0 } })).toBe(true);
    expect(isRunningWithoutPower({ speed: 20, ioData: { "66": "0" } })).toBe(true);
  });

  it("is false while the vehicle is parked: a tracker wired to the ignition reads 0 V all night", () => {
    expect(isRunningWithoutPower({ speed: 0, ioData: { "66": 0 } })).toBe(false);
  });

  it("is false with power present, and with no voltage reading at all", () => {
    expect(isRunningWithoutPower({ speed: 95, ioData: { "66": 14689 } })).toBe(false);
    expect(isRunningWithoutPower({ speed: 95, ioData: {} })).toBe(false);
    expect(isRunningWithoutPower(undefined)).toBe(false);
  });
});

describe("isSilentWhileMoving", () => {
  const now = at("2026-11-06T15:00:00Z");
  const moving = { speed: 95, ioData: {} };

  it("flags a moving vehicle whose tracker has said nothing for longer than the threshold", () => {
    expect(isSilentWhileMoving(moving, at("2026-11-06T14:40:00Z"), 15 * 60_000, now)).toBe(true);
  });

  it("waits until the threshold has passed", () => {
    expect(isSilentWhileMoving(moving, at("2026-11-06T14:50:00Z"), 15 * 60_000, now)).toBe(false);
  });

  it("does not flag a vehicle that was stopped, nor one never heard from", () => {
    expect(isSilentWhileMoving({ speed: 0, ioData: {} }, at("2026-11-06T10:00:00Z"), 15 * 60_000, now)).toBe(false);
    expect(isSilentWhileMoving(moving, null, 15 * 60_000, now)).toBe(false);
    expect(isSilentWhileMoving(undefined, at("2026-11-06T10:00:00Z"), 15 * 60_000, now)).toBe(false);
  });
});

describe("isReminderDue", () => {
  const every = 10 * 60_000;
  const first = at("2026-11-06T10:00:00Z");

  it("is due once the interval since the last notice has passed", () => {
    expect(isReminderDue({ firstTriggeredAt: first, lastNotifiedAt: at("2026-11-06T10:05:00Z") }, every, at("2026-11-06T10:15:30Z"))).toBe(true);
  });

  it("is not due before the interval", () => {
    expect(isReminderDue({ firstTriggeredAt: first, lastNotifiedAt: at("2026-11-06T10:05:00Z") }, every, at("2026-11-06T10:10:00Z"))).toBe(false);
  });

  it("is due on the pass that lands a few seconds short of the interval, so a 5-minute evaluator still reminds every 10", () => {
    expect(isReminderDue({ firstTriggeredAt: first, lastNotifiedAt: at("2026-11-06T10:05:03Z") }, every, at("2026-11-06T10:15:01Z"))).toBe(true);
  });

  it("stops after a day: the episode is stale", () => {
    const old = new Date(first.getTime() - REMINDER_MAX_AGE_MS - 1);
    expect(isReminderDue({ firstTriggeredAt: old, lastNotifiedAt: at("2026-11-06T09:00:00Z") }, every, first)).toBe(false);
  });
});

describe("messages", () => {
  it("name the vehicle and say what happened, in both languages", () => {
    expect(gpsNoPowerMessage("EX030XG", "es")).toContain("EX030XG");
    expect(gpsNoPowerMessage("EX030XG", "it")).toContain("corrente");
    expect(gpsSilentMessage("EX030XG", 42, "es")).toContain("42 min");
    expect(gpsSilentMessage("EX030XG", 42, "it")).toContain("42 min");
  });

  it("the urgent push is marked urgent and says RECORDATORIO only on a repeat", () => {
    const first = urgentPushMessage("Org", ["a"], "es", false);
    const repeat = urgentPushMessage("Org", ["a"], "es", true);
    expect(first.urgent).toBe(true);
    expect(first.title).not.toContain("RECORDATORIO");
    expect(repeat.title).toContain("RECORDATORIO");
    expect(urgentPushMessage("Org", ["a"], "it", true).title).toContain("PROMEMORIA");
  });
});
