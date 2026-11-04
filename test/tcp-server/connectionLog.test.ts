import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";
import { logger } from "../../src/config/logger.js";
import { describeRecord, codecLabel, plainIp } from "../../src/tcp-server/connectionLog.js";
import type { AvlRecord } from "../../src/tcp-server/codec8/types.js";
import { createTcpServer } from "../../src/tcp-server/server.js";
import type { DeviceConnectionHooks } from "../../src/tcp-server/connectionHandler.js";
import {
  CODEC8_EXAMPLE_1_HEX,
  CODEC8_EXTENDED_EXAMPLE_HEX,
  SAMPLE_IMEI,
  SAMPLE_IMEI_HANDSHAKE_HEX,
} from "./codec8/fixtures.js";

/** The `[tcp] conn=<id> ...` lines the server writes, so one device can be followed from connection to disconnection. */
describe("TCP connection logs", () => {
  let server: net.Server;
  let port: number;
  let lines: Array<{ level: string; text: string }>;

  const baseHooks: DeviceConnectionHooks = { onIdentify: () => true, onPacket: () => {}, onDisconnect: () => {} };

  beforeEach(() => {
    lines = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation(((_fields: unknown, text?: string) => {
        if (typeof text === "string" && text.startsWith("[tcp]")) lines.push({ level, text });
      }) as never);
    }
  });

  afterEach(() => {
    server?.close();
    vi.restoreAllMocks();
    env.DEBUG_TCP = false;
  });

  function start(hooks: DeviceConnectionHooks): Promise<void> {
    server = createTcpServer(hooks);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  const texts = () => lines.map((line) => line.text);
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  /** Connects, sends each frame after the previous answer arrived, then closes from the device's side. */
  async function runDevice(frames: string[], { close = true } = {}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let sent = 0;
      socket.on("error", reject);
      socket.on("close", () => resolve());
      const next = () => {
        if (sent < frames.length) socket.write(Buffer.from(frames[sent++]!, "hex"));
        else if (close) socket.end();
      };
      socket.on("connect", next);
      socket.on("data", next);
    });
    await waitFor(() => texts().some((t) => t.includes("device disconnected")));
  }

  it("follows one connection from connection to disconnection with the same id", async () => {
    await start({ ...baseHooks, onIdentify: () => ({ accepted: true, registered: false }) });
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX, CODEC8_EXAMPLE_1_HEX, CODEC8_EXTENDED_EXAMPLE_HEX]);

    const all = texts();
    expect(all[0]).toMatch(/^\[tcp\] conn=[0-9a-f]{6} new connection from 127\.0\.0\.1:\d+$/);
    const id = all[0]!.match(/conn=([0-9a-f]{6})/)![1];
    expect(all.every((t) => t.startsWith(`[tcp] conn=${id} `))).toBe(true);

    expect(all).toContain(`[tcp] conn=${id} device identified imei=${SAMPLE_IMEI} status=unclaimed reply=01`);
    expect(all.find((t) => t.includes("avl codec=08"))).toMatch(
      new RegExp(`imei=${SAMPLE_IMEI} avl codec=08 records=1 first=\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z last=\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z ack=1$`),
    );
    expect(all.some((t) => t.includes("avl codec=8E records=1"))).toBe(true);
    expect(all.find((t) => t.includes(" last lat="))).toMatch(/last lat=-?\d+\.\d{6} lng=-?\d+\.\d{6} speed=\d+ sats=\d+/);
    expect(all.at(-1)).toMatch(
      new RegExp(`^\\[tcp\\] conn=${id} device disconnected imei=${SAMPLE_IMEI} duration=\\d+\\.\\d packets=2 records=2 reason=client_closed$`),
    );
  });

  it("says whether the device is registered and what it was answered", async () => {
    await start({ ...baseHooks, onIdentify: () => ({ accepted: true, registered: true }) });
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX]);
    expect(texts().some((t) => t.endsWith(`device identified imei=${SAMPLE_IMEI} status=registered reply=01`))).toBe(true);
  });

  it("logs a rejected device with reply 00 and closes with reason rejected", async () => {
    await start({ ...baseHooks, onIdentify: () => false });
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX], { close: false });
    const warn = lines.find((line) => line.text.includes("device identified"));
    expect(warn).toEqual({ level: "warn", text: expect.stringMatching(/device identified imei=\d+ status=unknown reply=00$/) });
    expect(texts().at(-1)).toMatch(/device disconnected imei=\d+ duration=\d+\.\d packets=0 records=0 reason=rejected$/);
  });

  it("warns with the first bytes of a packet whose CRC is wrong, and still closes the connection", async () => {
    await start(baseHooks);
    // Same frame with its last CRC byte flipped.
    const corrupted = CODEC8_EXAMPLE_1_HEX.slice(0, -2) + (CODEC8_EXAMPLE_1_HEX.endsWith("00") ? "01" : "00");
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX, corrupted], { close: false });

    const warn = lines.find((line) => line.text.includes("parse error"));
    expect(warn?.level).toBe("warn");
    expect(warn?.text).toContain(`imei=${SAMPLE_IMEI} parse error: AVL packet CRC-16 mismatch`);
    expect(warn?.text).toContain(`bytes=${corrupted.slice(0, 128).toLowerCase()}`);
    expect(texts().at(-1)).toMatch(/reason=parse_error$/);
  });

  it("does not log packet contents in hex unless DEBUG_TCP is on", async () => {
    await start(baseHooks);
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX, CODEC8_EXAMPLE_1_HEX]);
    expect(texts().some((t) => / (rx|tx) \d+ bytes/.test(t))).toBe(false);

    lines.length = 0;
    env.DEBUG_TCP = true;
    await runDevice([SAMPLE_IMEI_HANDSHAKE_HEX, CODEC8_EXAMPLE_1_HEX]);
    expect(texts().some((t) => t.includes(`rx ${CODEC8_EXAMPLE_1_HEX.length / 2} bytes hex=${CODEC8_EXAMPLE_1_HEX.toLowerCase()}`))).toBe(true);
    expect(texts().some((t) => t.includes("tx 1 bytes hex=01"))).toBe(true);
    expect(texts().some((t) => t.includes("tx 4 bytes hex=00000001"))).toBe(true);
  });
});

describe("connection log helpers", () => {
  const record = (elements: Array<[number, number | bigint]>): AvlRecord => ({
    timestamp: new Date("2026-11-03T10:00:00Z"),
    priority: 0,
    gps: { longitude: 9.19, latitude: 45.4642, altitude: 0, angle: 0, satellites: 9, speed: 42 },
    io: { eventId: 0, elements: new Map(elements) },
  });

  it("shows ignition, movement and external voltage only when the record carries them", () => {
    expect(describeRecord(record([]))).toBe("lat=45.464200 lng=9.190000 speed=42 sats=9");
    expect(describeRecord(record([[239, 1], [240, 0], [66, 13200]]))).toBe(
      "lat=45.464200 lng=9.190000 speed=42 sats=9 ign=1 mov=0 vext=13200 vext_avl=66",
    );
  });

  it("falls back to AVL 800 for the external voltage when 66 is not there", () => {
    expect(describeRecord(record([[800, 12900n]]))).toContain("vext=12900 vext_avl=800");
    expect(describeRecord(record([[66, 13000], [800, 1]]))).toContain("vext=13000 vext_avl=66");
  });

  it("writes the codec as the documentation does and drops the IPv6 prefix of an IPv4 address", () => {
    expect(codecLabel(0x08)).toBe("08");
    expect(codecLabel(0x8e)).toBe("8E");
    expect(plainIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(plainIp("2001:db8::1")).toBe("2001:db8::1");
    expect(plainIp(undefined)).toBe("unknown");
  });
});
