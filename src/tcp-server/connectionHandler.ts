import type { Socket } from "node:net";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { isCodec12Frame, tryDecodeCodec12Response } from "./codec12.js";
import { registerConnection, unregisterConnection } from "./connections.js";
import { IMEI_ACCEPT, IMEI_REJECT, tryReadImei } from "./codec8/imei.js";
import { encodeAck, tryDecodeAvlFrame } from "./codec8/parser.js";
import type { ParsedAvlPacket } from "./codec8/types.js";
import { codecLabel, describeRecord, hexHead, isoOrInvalid, newConnectionId, plainIp } from "./connectionLog.js";

/** What identifying a device decided: whether to accept it and whether it already belongs to an organization. */
export interface IdentifyResult {
  accepted: boolean;
  /** True when the device is claimed by an organization, false when it is still "unclaimed". */
  registered?: boolean;
}

export interface DeviceConnectionHooks {
  /** Return false (or `{ accepted: false }`) to reject the connection (e.g. unknown/blocked IMEI). */
  onIdentify: (imei: string) => boolean | IdentifyResult | Promise<boolean | IdentifyResult>;
  onPacket: (imei: string, packet: ParsedAvlPacket) => void | Promise<void>;
  onDisconnect: (imei: string | undefined) => void;
  /** Runs after the AVL packet was acked: the moment it is safe to write a command to the device. */
  onPacketAcked?: (imei: string) => void | Promise<void>;
  /** The device answered a Codec 12 command with this text. */
  onCommandResponse?: (imei: string, text: string) => void | Promise<void>;
}

type ConnectionState = "AWAITING_IMEI" | "AWAITING_DATA";

/**
 * Wires a raw TCP socket to the Codec 8 / Codec 8 Extended protocol state machine.
 * TCP delivers a byte stream with no message boundaries, so every chunk is appended
 * to a per-connection buffer and we keep trying to decode complete frames from its head.
 *
 * Every log line of a connection carries the same short `conn=<id>` (and the IMEI once the device has said which it is), so one
 * device can be followed from its connection to its disconnection: `[tcp] conn=<id> ...`.
 */
export function handleDeviceConnection(socket: Socket, hooks: DeviceConnectionHooks): void {
  const conn = newConnectionId();
  const startedAt = Date.now();
  let state: ConnectionState = "AWAITING_IMEI";
  let buffer = Buffer.alloc(0);
  let imei: string | undefined;
  const remote = `${plainIp(socket.remoteAddress)}:${socket.remotePort}`;

  // What the disconnect line reports.
  let packets = 0;
  let records = 0;
  /** Why *we* closed it (rejected, parse error, processing error); unset when the other side or the network did. */
  let closeReason: string | undefined;
  let peerEnded = false;
  let socketError: NodeJS.ErrnoException | undefined;

  const log = (level: "info" | "warn" | "error", fields: Record<string, unknown>, text: string) =>
    logger[level]({ conn, ...fields }, `[tcp] conn=${conn} ${text}`);
  const who = () => imei ?? "unknown";

  /** Writes to the device; with DEBUG_TCP=true the bytes are also logged in full. */
  const send = (bytes: Buffer, end = false) => {
    if (env.DEBUG_TCP) log("info", { imei }, `imei=${who()} tx ${bytes.length} bytes hex=${bytes.toString("hex")}`);
    if (end) socket.end(bytes);
    else socket.write(bytes);
  };

  /** Decodes a frame; if it is malformed, says so (with the first bytes) before the error closes the connection as it always did. */
  function decodeOrWarn<T>(decode: () => T): T {
    try {
      return decode();
    } catch (err) {
      closeReason = "parse_error";
      const message = err instanceof Error ? err.message : String(err);
      log(
        "warn",
        { imei, err },
        `imei=${who()} parse error: ${message} bytes=${hexHead(buffer)} (buffered=${buffer.length} bytes)`,
      );
      throw err;
    }
  }

  log("info", { remote }, `new connection from ${remote}`);

  // Serialize processing: onIdentify/onPacket can be async (DB calls), and another
  // 'data' event can arrive before a prior processBuffer() finishes. Without this
  // chain, two invocations could run concurrently over the same mutable `buffer`.
  let processingChain: Promise<void> = Promise.resolve();

  socket.on("data", (chunk: Buffer) => {
    if (env.DEBUG_TCP) log("info", { imei }, `imei=${who()} rx ${chunk.length} bytes hex=${chunk.toString("hex")}`);
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

        const outcome = await hooks.onIdentify(result.imei);
        const { accepted, registered } = typeof outcome === "boolean" ? { accepted: outcome, registered: undefined } : outcome;
        const status = registered === undefined ? "unknown" : registered ? "registered" : "unclaimed";
        if (!accepted) {
          closeReason = "rejected";
          log("warn", { imei: result.imei, remote }, `device identified imei=${result.imei} status=${status} reply=00`);
          send(IMEI_REJECT, true);
          return;
        }
        send(IMEI_ACCEPT);
        log("info", { imei: result.imei, remote }, `device identified imei=${result.imei} status=${status} reply=01`);
        registerConnection(result.imei, socket);
        state = "AWAITING_DATA";
      }

      if (state === "AWAITING_DATA") {
        // A single TCP read can contain more than one AVL frame; drain them all.
        for (;;) {
          // Answers to our text commands come on the same stream as the AVL data and take no ACK.
          if (isCodec12Frame(buffer)) {
            const response = decodeOrWarn(() => tryDecodeCodec12Response(buffer));
            if (!response) break;
            buffer = buffer.subarray(response.consumedBytes);
            log("info", { imei, response: response.text }, `imei=${who()} device answered a command: ${response.text}`);
            await hooks.onCommandResponse?.(imei as string, response.text);
            continue;
          }

          const decoded = decodeOrWarn(() => tryDecodeAvlFrame(buffer));
          if (!decoded) break;
          buffer = buffer.subarray(decoded.consumedBytes);

          await hooks.onPacket(imei as string, decoded.packet);

          const ack = decoded.packet.records.length;
          send(encodeAck(ack));
          packets += 1;
          records += ack;

          const first = decoded.packet.records[0];
          const last = decoded.packet.records[ack - 1];
          log(
            "info",
            { imei },
            `imei=${who()} avl codec=${codecLabel(decoded.packet.codecId)} records=${ack} first=${first ? isoOrInvalid(first.timestamp) : "-"} last=${last ? isoOrInvalid(last.timestamp) : "-"} ack=${ack}`,
          );
          if (last) log("info", { imei }, `imei=${who()} last ${describeRecord(last)}`);

          await hooks.onPacketAcked?.(imei as string);
        }
      }
    } catch (err) {
      closeReason ??= "processing_error";
      log("error", { err, imei, remote }, `imei=${who()} error handling device connection, closing socket`);
      socket.destroy();
    }
  }

  socket.on("end", () => {
    peerEnded = true;
  });

  socket.on("close", () => {
    if (imei) unregisterConnection(imei, socket);
    hooks.onDisconnect(imei);
    const reason = closeReason ?? (socketError ? `error:${socketError.code ?? socketError.message}` : peerEnded ? "client_closed" : "server_closed");
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log("info", { imei, remote }, `device disconnected imei=${who()} duration=${seconds} packets=${packets} records=${records} reason=${reason}`);
  });

  socket.on("error", (err) => {
    socketError = err;
    log("warn", { err, imei, remote }, `imei=${who()} socket error: ${err.message}`);
  });
}
