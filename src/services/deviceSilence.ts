import { AVL_ID } from "../tcp-server/codec8/avlIds.js";

/**
 * Whether the last report said the vehicle was parked with the engine off. Many trackers (Radius Velocity's among them)
 * simply stop reporting then, powered by the vehicle's battery all the while, so their silence is no sign of a fault: it is
 * only worth a notice when the vehicle went quiet while in use. A report without an ignition reading says nothing, so the
 * silence is still flagged. A tracker that was really unplugged is caught by its own unplug alarm, not by silence.
 */
export function wasParkedWithEngineOff(position: { speed: number; ioData: unknown } | undefined): boolean {
  if (!position) return false;
  const ignition = (position.ioData as Record<string, number | string | undefined>)[AVL_ID.IGNITION];
  return (ignition === 0 || ignition === "0") && position.speed === 0;
}
