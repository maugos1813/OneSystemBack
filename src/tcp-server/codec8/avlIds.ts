/**
 * A handful of well-known Teltonika AVL IDs, used to derive `device_events` from the
 * raw IO elements. This is intentionally NOT the full AVL ID dictionary (there are
 * hundreds, and they vary slightly per device family) — extend as needed.
 * Reference: https://wiki.teltonika-gps.com/view/Teltonika_AVL_ID
 */
export const AVL_ID = {
  DIGITAL_INPUT_1: 1,
  GSM_SIGNAL: 21,
  EXTERNAL_VOLTAGE: 66,
  BATTERY_VOLTAGE: 67,
  IGNITION: 239,
  MOVEMENT: 240,
  TOTAL_ODOMETER: 16,
} as const;
