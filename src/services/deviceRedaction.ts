import type { Device } from "../db/schema/index.js";

/**
 * What a client may know about its own devices. The hardware identity (IMEI, serial number, firmware) is OneSystec's: a
 * client identifies a device by its vehicle and model, and never gets the identifiers it could use to claim or clone one.
 * The IMEI is replaced by an empty string (not removed) so every consumer of the Device shape keeps working.
 */
export function redactDevice<T extends Pick<Device, "imei" | "serialNumber" | "firmware">>(device: T): T {
  return { ...device, imei: "", serialNumber: null, firmware: null };
}
