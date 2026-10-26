import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { deviceCommands, devices, type Device, type DeviceCommand } from "../db/schema/index.js";
import { encodeCodec12Command } from "../tcp-server/codec12.js";
import { sendToDevice } from "../tcp-server/connections.js";
import { getDeviceById } from "./device.service.js";
import { DRIVING_RULES } from "./drivingStyle.service.js";
import { getLatestReading } from "./position.service.js";

export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Models whose DOUT1 we know how to drive. Others may have outputs too, but aren't offered until checked. */
const IMMOBILIZER_MODELS: ReadonlySet<string> = new Set(["FTC920", "FMB920"]);

export function supportsImmobilizer(model: string): boolean {
  return IMMOBILIZER_MODELS.has(model);
}

/**
 * Models whose Green Driving parameters are in Teltonika's own parameter lists (FMB204 and FMC003 pages, FMB920 in the Green Driving
 * Solution page): 11000 scenario priority (0 off, 1 low), 11004/11005/11006 the limits for acceleration, braking and cornering in
 * m/s², 11007 the source (0 GPS, 1 accelerometer). Off by default, which is why a device sends no harsh-driving events (AVL 253) until
 * it is switched on.
 */
const GREEN_DRIVING_MODELS: ReadonlySet<string> = new Set(["FMB204", "FMC003", "FMB920"]);

export function supportsGreenDriving(model: string): boolean {
  return GREEN_DRIVING_MODELS.has(model);
}

export type GreenDrivingAction = "enable" | "disable";
export type GreenDrivingSource = "accelerometer" | "gps";

/** The order for the device (GPRS "setparam"), using the same limits OneTrack's own detection uses. */
export function greenDrivingCommand(action: GreenDrivingAction, source: GreenDrivingSource = "accelerometer"): string {
  if (action === "disable") return "setparam 11000:0";
  const { harshAccelerationMs2: acceleration, harshBrakingMs2: braking, harshCorneringMs2: cornering } = DRIVING_RULES;
  return `setparam 11000:1;11004:${acceleration};11005:${braking};11006:${cornering};11007:${source === "gps" ? 0 : 1}`;
}

/** A settings change can wait for a device that is off the network: it is harmless late, unlike a lock. */
const GREEN_DRIVING_TTL_MS = 24 * 60 * 60_000;

export type ImmobilizerAction = "lock" | "unlock";

const KIND = { lock: "immobilize", unlock: "release" } as const;
/** Teltonika's output command: "setdigout 1" raises DOUT1 and keeps it up, "setdigout 0" drops it. */
const COMMAND_TEXT = { immobilize: "setdigout 1", release: "setdigout 0" } as const;

/** A lock that cannot be delivered soon is dropped: it must never fire an hour later on a moving truck.
 * An unlock is the safe direction, so it waits longer for a device that is off the network. */
const TTL_MS = { immobilize: 5 * 60_000, release: 60 * 60_000 } as const;
/** A device that took the command but never answered is reported as failed after this. */
const ANSWER_TIMEOUT_MS = 5 * 60_000;

/** Above this speed the vehicle counts as moving, and locking it is refused. */
const MOVING_KMH = 5;
/** A position older than this says nothing about whether the vehicle is moving now. */
const FRESH_MS = 3 * 60_000;

export const MOVING_MESSAGE = "El vehículo está en movimiento. Espera a que se detenga para bloquearlo.";

/** The newest report shows the vehicle rolling, so cutting the engine could cause an accident. */
export async function isMoving(deviceId: string, now: Date): Promise<boolean> {
  const reading = await getLatestReading(deviceId);
  if (!reading) return false;
  return now.getTime() - reading.ts.getTime() <= FRESH_MS && reading.speed > MOVING_KMH;
}

/**
 * Queues a lock/unlock of the vehicle's output. The newest order replaces any still waiting,
 * and it is written to the device right away when it is connected.
 */
export async function requestImmobilizer(
  orgId: string,
  userId: string,
  deviceId: string,
  action: ImmobilizerAction,
  now: Date = new Date(),
): Promise<DeviceCommand> {
  const device = await getDeviceById(deviceId);
  if (!device || device.orgId !== orgId) throw new CommandError(404, "Device not found");
  if (!supportsImmobilizer(device.model)) {
    throw new CommandError(400, `El modelo ${device.model} no tiene el bloqueo remoto habilitado`);
  }
  const kind = KIND[action];
  if (kind === "immobilize" && (await isMoving(device.id, now))) throw new CommandError(409, MOVING_MESSAGE);

  await db
    .update(deviceCommands)
    .set({ status: "cancelled", response: "Reemplazado por una orden más nueva", answeredAt: now })
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        eq(deviceCommands.status, "pending"),
        // A lock replaces a lock, never a settings change that is still waiting for the device.
        inArray(deviceCommands.kind, ["immobilize", "release"]),
      ),
    );

  const [row] = await db
    .insert(deviceCommands)
    .values({
      orgId,
      deviceId: device.id,
      userId,
      kind,
      command: COMMAND_TEXT[kind],
      expiresAt: new Date(now.getTime() + TTL_MS[kind]),
    })
    .returning();
  await dispatchPendingCommands(device, now);
  return (await getCommand(row!.id)) ?? row!;
}

/** Queues the switch of the device's own harsh-driving measurement. The newest settings order replaces any still waiting. */
export async function requestGreenDriving(
  orgId: string,
  userId: string,
  deviceId: string,
  action: GreenDrivingAction,
  source: GreenDrivingSource = "accelerometer",
  now: Date = new Date(),
): Promise<DeviceCommand> {
  const device = await getDeviceById(deviceId);
  if (!device || device.orgId !== orgId) throw new CommandError(404, "Device not found");
  if (device.source !== "teltonika") throw new CommandError(400, "Este equipo no se configura desde OneTrack");
  if (!supportsGreenDriving(device.model)) {
    throw new CommandError(400, `El modelo ${device.model} no tiene la medición de conducción habilitada`);
  }

  await db
    .update(deviceCommands)
    .set({ status: "cancelled", response: "Reemplazado por una orden más nueva", answeredAt: now })
    .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.kind, "green_driving"), eq(deviceCommands.status, "pending")));

  const [row] = await db
    .insert(deviceCommands)
    .values({
      orgId,
      deviceId: device.id,
      userId,
      kind: "green_driving",
      command: greenDrivingCommand(action, source),
      expiresAt: new Date(now.getTime() + GREEN_DRIVING_TTL_MS),
    })
    .returning();
  await dispatchPendingCommands(device, now);
  return (await getCommand(row!.id)) ?? row!;
}

async function getCommand(id: string): Promise<DeviceCommand | undefined> {
  const [row] = await db.select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row;
}

/**
 * Writes the oldest waiting command to the device if it is connected now. Called when an order is
 * made and every time the device reports, which is when it is known to be there. A lock is held
 * back while the vehicle is moving and goes out once it stops (until it expires).
 */
export async function dispatchPendingCommands(device: Pick<Device, "id" | "imei">, now: Date = new Date()): Promise<void> {
  await db
    .update(deviceCommands)
    .set({ status: "expired", response: "No se pudo entregar a tiempo", answeredAt: now })
    .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.status, "pending"), lt(deviceCommands.expiresAt, now)));

  const [next] = await db
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.status, "pending")))
    .orderBy(asc(deviceCommands.createdAt))
    .limit(1);
  if (!next) return;
  if (next.kind === "immobilize" && (await isMoving(device.id, now))) return;

  if (sendToDevice(device.imei, encodeCodec12Command(next.command))) {
    await db.update(deviceCommands).set({ status: "sent", sentAt: now }).where(eq(deviceCommands.id, next.id));
  }
}

const FAILURE = /error|wrong|unknown|invalid|fail|not supported/i;

/** The device answered the command we sent it last. */
export async function recordCommandResponse(deviceId: string, text: string, now: Date = new Date()): Promise<void> {
  const [sent] = await db
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, "sent")))
    .orderBy(desc(deviceCommands.sentAt))
    .limit(1);
  if (!sent) return;
  const failed = FAILURE.test(text);
  await db
    .update(deviceCommands)
    .set({ status: failed ? "failed" : "confirmed", response: text.slice(0, 500), answeredAt: now })
    .where(eq(deviceCommands.id, sent.id));

  // From the moment the device accepted the settings, its own harsh-driving events count (and from there only).
  if (!failed && sent.kind === "green_driving") {
    await db
      .update(devices)
      .set({ greenDrivingSince: sent.command.includes("11000:0") ? null : now })
      .where(eq(devices.id, deviceId));
  }
}

/** The latest orders of a device, newest first. Orders the device took but never answered are closed as failed. */
export async function listDeviceCommands(
  orgId: string,
  deviceId: string,
  now: Date = new Date(),
  limit = 10,
): Promise<DeviceCommand[]> {
  await db
    .update(deviceCommands)
    .set({ status: "failed", response: "El equipo no respondió", answeredAt: now })
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.orgId, orgId),
        eq(deviceCommands.status, "sent"),
        lt(deviceCommands.sentAt, new Date(now.getTime() - ANSWER_TIMEOUT_MS)),
      ),
    );
  await db
    .update(deviceCommands)
    .set({ status: "expired", response: "No se pudo entregar a tiempo", answeredAt: now })
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.orgId, orgId),
        eq(deviceCommands.status, "pending"),
        lt(deviceCommands.expiresAt, now),
      ),
    );
  return db
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.orgId, orgId)))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(limit);
}
