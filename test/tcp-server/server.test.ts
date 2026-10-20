import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCodec12Command } from "../../src/tcp-server/codec12.js";
import { sendToDevice } from "../../src/tcp-server/connections.js";
import { crc16ibm } from "../../src/tcp-server/codec8/crc16.js";
import { createTcpServer } from "../../src/tcp-server/server.js";
import type { DeviceConnectionHooks } from "../../src/tcp-server/connectionHandler.js";
import {
  CODEC8_EXAMPLE_1_HEX,
  CODEC8_EXTENDED_EXAMPLE_HEX,
  SAMPLE_IMEI,
  SAMPLE_IMEI_HANDSHAKE_HEX,
} from "./codec8/fixtures.js";

/**
 * End-to-end test of the protocol layer over a real TCP socket (no DB involved):
 * connect, do the IMEI handshake, send AVL packets, and assert on the ACKs — the same
 * flow a physical FMB204 (or test/tools/simulate-device.ts) would go through.
 */
describe("TCP ingestion server", () => {
  let server: net.Server;
  let port: number;

  function start(hooks: DeviceConnectionHooks): Promise<void> {
    server = createTcpServer(hooks);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(() => {
    server?.close();
  });

  it("accepts a known IMEI and acks each AVL packet with its record count", async () => {
    const onPacket = vi.fn();
    await start({
      onIdentify: async (imei) => imei === SAMPLE_IMEI,
      onPacket,
      onDisconnect: () => {},
    });

    const responses = await runClient(port, [
      Buffer.from(SAMPLE_IMEI_HANDSHAKE_HEX, "hex"),
      Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex"),
      Buffer.from(CODEC8_EXTENDED_EXAMPLE_HEX, "hex"),
    ]);

    // 1 byte IMEI-accept, then a 4-byte ACK per AVL packet.
    expect(responses[0]).toEqual(Buffer.from([0x01]));
    expect(responses[1]!.readUInt32BE(0)).toBe(1);
    expect(responses[2]!.readUInt32BE(0)).toBe(1);
    expect(onPacket).toHaveBeenCalledTimes(2);
    expect(onPacket).toHaveBeenNthCalledWith(1, SAMPLE_IMEI, expect.objectContaining({ codecId: 0x08 }));
    expect(onPacket).toHaveBeenNthCalledWith(2, SAMPLE_IMEI, expect.objectContaining({ codecId: 0x8e }));
  });

  it("writes a command to a connected device after its ACK and reads the answer back", async () => {
    const onCommandResponse = vi.fn();
    await start({
      onIdentify: async () => true,
      onPacket: vi.fn(),
      onPacketAcked: (imei) => {
        sendToDevice(imei, encodeCodec12Command("setdigout 1"));
      },
      onCommandResponse,
      onDisconnect: () => {},
    });

    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.on("connect", () => socket.write(Buffer.from(SAMPLE_IMEI_HANDSHAKE_HEX, "hex")));
      socket.on("data", (chunk) => {
        received.push(chunk);
        if (received.length === 1) socket.write(Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex"));
        // 4-byte ACK and the command frame can arrive in one read; the command is whatever follows the ACK.
        const all = Buffer.concat(received);
        if (all.length >= 1 + 4 + encodeCodec12Command("setdigout 1").length) {
          const text = Buffer.from("DOUT1:1 Timeout:INFINITY", "ascii");
          const size = Buffer.alloc(4);
          size.writeUInt32BE(text.length);
          const data = Buffer.concat([Buffer.from([0x0c, 0x01, 0x06]), size, text, Buffer.from([0x01])]);
          const head = Buffer.alloc(8);
          head.writeUInt32BE(data.length, 4);
          const crc = Buffer.alloc(4);
          crc.writeUInt32BE(crc16ibm(data));
          socket.write(Buffer.concat([head, data, crc]), () => setTimeout(() => socket.end(), 50));
        }
      });
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });

    const all = Buffer.concat(received);
    expect(all.subarray(0, 1)).toEqual(Buffer.from([0x01]));
    expect(all.readUInt32BE(1)).toBe(1); // the AVL ACK comes first
    expect(all.subarray(5)).toEqual(encodeCodec12Command("setdigout 1"));
    expect(onCommandResponse).toHaveBeenCalledWith(SAMPLE_IMEI, "DOUT1:1 Timeout:INFINITY");
  });

  it("rejects an unknown IMEI and closes the connection", async () => {
    await start({
      onIdentify: async () => false,
      onPacket: vi.fn(),
      onDisconnect: () => {},
    });

    const responses = await runClient(port, [Buffer.from(SAMPLE_IMEI_HANDSHAKE_HEX, "hex")]);
    expect(responses[0]).toEqual(Buffer.from([0x00]));
  });
});

/** Sends each buffer only after the previous one's response arrives, and collects
 * one response Buffer per message sent. */
function runClient(port: number, messages: Buffer[]): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const responses: Buffer[] = [];
    let index = 0;

    socket.on("connect", () => socket.write(messages[index]!));

    socket.on("data", (chunk) => {
      responses.push(chunk);
      index += 1;
      if (index < messages.length) {
        socket.write(messages[index]!);
      } else {
        socket.end();
      }
    });

    socket.on("close", () => resolve(responses));
    socket.on("error", reject);
  });
}
