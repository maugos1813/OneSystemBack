import { describe, expect, it } from "vitest";
import {
  ALARM_MAX_AGE_MS,
  DEVICE_ALARM_KEYS,
  DEVICE_ALARMS,
  findTrackingGaps,
  isAlarmActive,
  isTrackingGapActive,
  trackingGapMessage,
} from "../../src/services/deviceAlarms.js";
import { eventTypeFromAvlId } from "../../src/services/position.service.js";
import { DEFAULT_SETTINGS, withDefaults } from "../../src/services/settings.service.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("tracker alarms", () => {
  it("maps each alarm IO element to its own event type, and keeps the old ones", () => {
    expect(eventTypeFromAvlId(252)).toBe("unplug_change");
    expect(eventTypeFromAvlId(249)).toBe("jamming_change");
    expect(eventTypeFromAvlId(246)).toBe("towing_change");
    expect(eventTypeFromAvlId(247)).toBe("crash_change");
    expect(eventTypeFromAvlId(239)).toBe("ignition_change");
    expect(eventTypeFromAvlId(240)).toBe("movement_change");
    expect(eventTypeFromAvlId(999)).toBe("avl_999");
  });

  it("uses distinct event types and AVL ids, short enough for the alert_type column", () => {
    expect(new Set(DEVICE_ALARM_KEYS.map((k) => DEVICE_ALARMS[k].eventType)).size).toBe(DEVICE_ALARM_KEYS.length);
    expect(new Set(DEVICE_ALARM_KEYS.map((k) => DEVICE_ALARMS[k].avlId)).size).toBe(DEVICE_ALARM_KEYS.length);
    for (const key of DEVICE_ALARM_KEYS) expect(key.length).toBeLessThanOrEqual(30);
  });

  it("is active while the latest event carries a non-zero value", () => {
    expect(isAlarmActive({ "252": 1 }, 252, ago(60_000), NOW)).toBe(true);
    expect(isAlarmActive({ "252": "1" }, 252, ago(60_000), NOW)).toBe(true);
    expect(isAlarmActive({ "247": 3 }, 247, ago(60_000), NOW)).toBe(true); // crash severity
    expect(isAlarmActive({ "252": 0 }, 252, ago(60_000), NOW)).toBe(false);
  });

  it("is not active when the value is missing or the payload is empty", () => {
    expect(isAlarmActive({ "66": 12000 }, 252, ago(1000), NOW)).toBe(false);
    expect(isAlarmActive({}, 252, ago(1000), NOW)).toBe(false);
    expect(isAlarmActive(null, 252, ago(1000), NOW)).toBe(false);
  });

  it("lets an old episode lapse instead of staying open forever", () => {
    expect(isAlarmActive({ "252": 1 }, 252, ago(ALARM_MAX_AGE_MS - 1000), NOW)).toBe(true);
    expect(isAlarmActive({ "252": 1 }, 252, ago(ALARM_MAX_AGE_MS + 1000), NOW)).toBe(false);
  });

  it("writes a readable message for each alarm with the vehicle name", () => {
    for (const key of DEVICE_ALARM_KEYS) expect(DEVICE_ALARMS[key].alert("VAN-1")).toContain("VAN-1");
  });

  it("is on by default, also for organizations that saved settings before it existed", () => {
    expect(DEFAULT_SETTINGS.alerts.deviceAlarmsEnabled).toBe(true);
    const legacy = withDefaults({ alerts: { speedingEnabled: false }, workingHours: {} });
    expect(legacy.alerts.deviceAlarmsEnabled).toBe(true);
    expect(legacy.alerts.speedingEnabled).toBe(false);
  });
});

describe("tracking gaps", () => {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

  it("finds the stretches of an hour or more with no record, measured from the newest stored one", () => {
    expect(findTrackingGaps(at(0), [at(10), at(20)])).toEqual([]);
    expect(findTrackingGaps(at(0), [at(90)])).toEqual([{ from: at(0), to: at(90) }]);
    expect(findTrackingGaps(at(0), [at(200), at(210), at(400)])).toEqual([
      { from: at(0), to: at(200) },
      { from: at(210), to: at(400) },
    ]);
    expect(findTrackingGaps(null, [at(0), at(500)])).toEqual([{ from: at(0), to: at(500) }]);
    expect(findTrackingGaps(null, [at(0)])).toEqual([]);
  });

  it("is raised for a day, then lapses", () => {
    expect(isTrackingGapActive(ago(60_000), NOW)).toBe(true);
    expect(isTrackingGapActive(ago(ALARM_MAX_AGE_MS + 1000), NOW)).toBe(false);
  });

  it("reads how long the tracker did not record, in both languages", () => {
    expect(trackingGapMessage("EX030XG", { minutes: 706 })).toContain("11 h 46 min");
    expect(trackingGapMessage("EX030XG", { minutes: 45 }, "it")).toContain("45 min");
    expect(trackingGapMessage("EX030XG", { minutes: 706 }, "it")).toContain("EX030XG");
  });
});
