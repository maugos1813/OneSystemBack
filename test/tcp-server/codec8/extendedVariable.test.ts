import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc16ibm } from "../../../src/tcp-server/codec8/crc16.js";
import { serializeIoElements } from "../../../src/tcp-server/codec8/ioSerialize.js";
import { tryDecodeAvlFrame } from "../../../src/tcp-server/codec8/parser.js";
import { createTcpServer } from "../../../src/tcp-server/server.js";

/**
 * Codec 8 Extended frames of the kind an FMC003 sends once OBD, beacons and alarms are on: IDs above
 * 255 in every width and variable-length (NX) elements such as the VIN, fault codes and beacon data.
 * The documented fixtures have no NX element, so these frames are built field by field here.
 */

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

interface RecordSpec {
  ts: Date;
  lat?: number;
  lng?: number;
  satellites?: number;
  eventId?: number;
  b1?: Array<[number, number]>;
  b2?: Array<[number, number]>;
  b4?: Array<[number, number]>;
  b8?: Array<[number, bigint]>;
  nx?: Array<[number, Buffer]>;
}

function record(spec: RecordSpec): Buffer {
  const b1 = spec.b1 ?? [];
  const b2 = spec.b2 ?? [];
  const b4 = spec.b4 ?? [];
  const b8 = spec.b8 ?? [];
  const nx = spec.nx ?? [];
  const total = b1.length + b2.length + b4.length + b8.length + nx.length;
  return Buffer.concat([
    u64(BigInt(spec.ts.getTime())),
    u8(1), // priority
    i32(Math.round((spec.lng ?? 0) * 1e7)),
    i32(Math.round((spec.lat ?? 0) * 1e7)),
    u16(0), // altitude
    u16(0), // angle
    u8(spec.satellites ?? 0),
    u16(0), // speed
    u16(spec.eventId ?? 0),
    u16(total),
    u16(b1.length),
    ...b1.map(([id, v]) => Buffer.concat([u16(id), u8(v)])),
    u16(b2.length),
    ...b2.map(([id, v]) => Buffer.concat([u16(id), u16(v)])),
    u16(b4.length),
    ...b4.map(([id, v]) => Buffer.concat([u16(id), u32(v)])),
    u16(b8.length),
    ...b8.map(([id, v]) => Buffer.concat([u16(id), u64(v)])),
    u16(nx.length),
    ...nx.map(([id, data]) => Buffer.concat([u16(id), u16(data.length), data])),
  ]);
}

function frame(records: Buffer[]): Buffer {
  const data = Buffer.concat([u8(0x8e), u8(records.length), ...records, u8(records.length)]);
  return Buffer.concat([u32(0), u32(data.length), data, u32(crc16ibm(data))]);
}

const T = new Date("2026-10-17T10:00:00Z");
const VIN = "ZFA19900000123456";

describe("Codec 8 Extended with variable-length elements", () => {
  it("decodes IDs above 255 in every width and the NX elements (VIN, fault codes, beacon data)", () => {
    const beacon = Buffer.from("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "hex");
    const buf = frame([
      record({
        ts: T,
        lat: 45.385,
        lng: 9.263,
        satellites: 17,
        eventId: 252,
        b1: [
          [239, 1],
          [252, 1],
          [30, 0],
        ],
        b2: [
          [66, 12566],
          [36, 850],
        ],
        b4: [
          [389, 21916],
          [16, 152000],
        ],
        b8: [[11, 8939010002782221067n]],
        nx: [
          [256, Buffer.from(VIN, "ascii")],
          [281, Buffer.from("P0420,P0171", "ascii")],
          [385, beacon],
        ],
      }),
    ]);

    const result = tryDecodeAvlFrame(buf);
    expect(result).not.toBeNull();
    expect(result!.consumedBytes).toBe(buf.length);
    const [rec] = result!.packet.records;
    expect(rec!.gps).toMatchObject({ latitude: 45.385, longitude: 9.263, satellites: 17 });
    expect(rec!.io.eventId).toBe(252);
    expect(rec!.io.elements.get(389)).toBe(21916);
    expect(rec!.io.elements.get(66)).toBe(12566);
    expect(rec!.io.elements.get(11)).toBe(8939010002782221067n);
    expect((rec!.io.elements.get(256) as Buffer).toString("ascii")).toBe(VIN);
    expect((rec!.io.elements.get(281) as Buffer).toString("ascii")).toBe("P0420,P0171");
    expect(rec!.io.elements.get(385)).toEqual(beacon);
  });

  it("stores the NX elements as hex and the wide ones as decimal strings, safe for jsonb", () => {
    const [rec] = tryDecodeAvlFrame(
      frame([record({ ts: T, b8: [[11, 8939010002782221067n]], nx: [[256, Buffer.from(VIN, "ascii")]] })]),
    )!.packet.records;
    const stored = serializeIoElements(rec!.io);
    expect(stored["256"]).toBe(Buffer.from(VIN, "ascii").toString("hex"));
    expect(stored["11"]).toBe("8939010002782221067");
    expect(() => JSON.stringify(stored)).not.toThrow();
  });

  it("decodes several records in one packet, including ones with no fix and no NX element", () => {
    const buf = frame([
      record({ ts: T, nx: [[281, Buffer.from("P0420", "ascii")]] }),
      record({ ts: new Date(T.getTime() + 5000), lat: 45.4, lng: 9.2, satellites: 12, b2: [[36, 900]] }),
      record({ ts: new Date(T.getTime() + 10_000), nx: [] }),
    ]);
    const result = tryDecodeAvlFrame(buf)!;
    expect(result.packet.records).toHaveLength(3);
    expect(result.packet.records[0]!.gps).toMatchObject({ latitude: 0, longitude: 0, satellites: 0 });
    expect(result.packet.records[1]!.io.elements.get(36)).toBe(900);
    expect(result.packet.records[2]!.io.elements.size).toBe(0);
  });

  it("handles an empty NX element (length 0) and a long one", () => {
    const long = Buffer.alloc(300, 0x41);
    const [rec] = tryDecodeAvlFrame(
      frame([
        record({
          ts: T,
          nx: [
            [256, Buffer.alloc(0)],
            [281, long],
          ],
        }),
      ]),
    )!.packet.records;
    expect((rec!.io.elements.get(256) as Buffer).length).toBe(0);
    expect((rec!.io.elements.get(281) as Buffer).length).toBe(300);
  });

  it("waits for the rest when such a frame arrives split in two reads", () => {
    const buf = frame([record({ ts: T, nx: [[256, Buffer.from(VIN, "ascii")]] })]);
    expect(tryDecodeAvlFrame(buf.subarray(0, buf.length - 10))).toBeNull();
    expect(tryDecodeAvlFrame(buf)).not.toBeNull();
  });
});

describe("over a real TCP socket", () => {
  let server: net.Server;
  afterEach(() => {
    server?.close();
  });

  it("acks a Codec 8 Extended packet with NX elements with its record count", async () => {
    const onPacket = vi.fn();
    server = createTcpServer({ onIdentify: async () => true, onPacket, onDisconnect: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const imei = "860848088107876";
    const handshake = Buffer.concat([u16(imei.length), Buffer.from(imei, "ascii")]);
    const packet = frame([
      record({ ts: T, nx: [[256, Buffer.from(VIN, "ascii")]], b4: [[389, 21916]] }),
      record({ ts: new Date(T.getTime() + 5000), b2: [[66, 12566]] }),
    ]);

    const responses = await new Promise<Buffer[]>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const out: Buffer[] = [];
      const messages = [handshake, packet];
      let i = 0;
      socket.on("connect", () => socket.write(messages[i]!));
      socket.on("data", (chunk) => {
        out.push(chunk);
        i += 1;
        if (i < messages.length) socket.write(messages[i]!);
        else socket.end();
      });
      socket.on("close", () => resolve(out));
      socket.on("error", reject);
    });

    expect(responses[0]).toEqual(Buffer.from([0x01]));
    expect(responses[1]!.readUInt32BE(0)).toBe(2);
    expect(onPacket).toHaveBeenCalledTimes(1);
    expect(onPacket.mock.calls[0]![0]).toBe(imei);
    expect(onPacket.mock.calls[0]![1].records).toHaveLength(2);
  });
});
