import type { Socket } from "node:net";
import { logger } from "../config/logger.js";
import { IMEI_ACCEPT, IMEI_REJECT, tryReadImei } from "./codec8/imei.js";
import { encodeAck, tryDecodeAvlFrame } from "./codec8/parser.js";
import type { ParsedAvlPacket } from "./codec8/types.js";

export interface DeviceConnectionHooks {
  /** Return false to reject the connection (e.g. unknown/blocked IMEI). */
  onIdentify: (imei: string) => boolean | Promise<boolean>;
  onPacket: (imei: string, packet: ParsedAvlPacket) => void | Promise<void>;
  onDisconnect: (imei: string | undefined) => void;
}

type ConnectionState = "AWAITING_IMEI" | "AWAITING_DATA";

/**
 * Wires a raw TCP socket to the Codec 8 / Codec 8 Extended protocol state machine.
 * TCP delivers a byte stream with no message boundaries, so every chunk is appended
 * to a per-connection buffer and we keep trying to decode complete frames from its head.
 */
export function handleDeviceConnection(socket: Socket, hooks: DeviceConnectionHooks): void {
  let state: ConnectionState = "AWAITING_IMEI";
  let buffer = Buffer.alloc(0);
  let imei: string | undefined;
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;

  // Serialize processing: onIdentify/onPacket can be async (DB calls), and another
  // 'data' event can arrive before a prior processBuffer() finishes. Without this
  // chain, two invocations could run concurrently over the same mutable `buffer`.
  let processingChain: Promise<void> = Promise.resolve();

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processingChain = processingChain.then(processBuffer);
  });

  async function processBuffer(): Promise<void> {
    try {
      if (state === "AWAITING_IMEI") {
        const result = tryReadImei(buffer);
        if (!result) return;
        buffer = buffer.subarray(result.consumedBytes);
        imei = result.imei;

        const accepted = await hooks.onIdentify(result.imei);
        if (!accepted) {
          logger.warn({ imei: result.imei, remote }, "rejecting device connection");
          socket.end(IMEI_REJECT);
          return;
        }
        logger.info({ imei: result.imei, remote }, "device identified");
        socket.write(IMEI_ACCEPT);
        state = "AWAITING_DATA";
      }

      if (state === "AWAITING_DATA") {
        // A single TCP read can contain more than one AVL frame; drain them all.
        for (;;) {
          const decoded = tryDecodeAvlFrame(buffer);
          if (!decoded) break;
          buffer = buffer.subarray(decoded.consumedBytes);

          await hooks.onPacket(imei as string, decoded.packet);

          socket.write(encodeAck(decoded.packet.records.length));
          logger.debug({ imei, records: decoded.packet.records.length }, "acked AVL packet");
        }
      }
    } catch (err) {
      logger.error({ err, imei, remote }, "error handling device connection, closing socket");
      socket.destroy();
    }
  }

  socket.on("close", () => {
    hooks.onDisconnect(imei);
    logger.info({ imei, remote }, "device disconnected");
  });

  socket.on("error", (err) => {
    logger.warn({ err, imei, remote }, "socket error");
  });
}
