import type { Socket } from "node:net";

/**
 * The sockets of the devices connected right now, by IMEI. A device only talks to us when it has
 * data to send, so a command can only be written while its socket is here; anything issued
 * outside that window waits in the database until the device next connects.
 */
const connections = new Map<string, Socket>();

export function registerConnection(imei: string, socket: Socket): void {
  const previous = connections.get(imei);
  connections.set(imei, socket);
  // A device that reconnects leaves its old socket half-open on our side; drop it.
  if (previous && previous !== socket) previous.destroy();
}

/** Forgets a socket, but only if it is still the current one (a newer connection may have replaced it). */
export function unregisterConnection(imei: string, socket: Socket): void {
  if (connections.get(imei) === socket) connections.delete(imei);
}

/** Writes a frame to the device if it is connected. Returns whether it was written. */
export function sendToDevice(imei: string, frame: Buffer): boolean {
  const socket = connections.get(imei);
  if (!socket || socket.destroyed || !socket.writable) return false;
  socket.write(frame);
  return true;
}
