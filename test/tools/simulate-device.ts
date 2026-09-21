/**
 * Simulates a Teltonika FMB204 talking Codec 8 Extended over TCP, without needing the
 * physical hardware: opens a socket to the ingestion server, does the IMEI handshake,
 * sends one AVL packet, and prints whatever the server sends back.
 *
 * Usage:
 *   npm run simulate:device
 *   SIM_HOST=localhost SIM_PORT=5027 SIM_IMEI=356307042441013 npm run simulate:device
 */
import net from "node:net";

const host = process.env.SIM_HOST ?? "localhost";
const port = Number(process.env.SIM_PORT ?? 5027);
const imei = process.env.SIM_IMEI ?? "356307042441013";

function imeiHandshake(value: string): Buffer {
  const ascii = Buffer.from(value, "ascii");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(ascii.length, 0);
  return Buffer.concat([length, ascii]);
}

/**
 * One Codec 8 Extended AVL packet with a single record: current timestamp, a fixed
 * GPS fix (Vilnius, where Teltonika is headquartered), and an ignition-on IO element.
 */
function buildSamplePacket(): Buffer {
  const CODEC_8_EXTENDED = 0x8e;
  const now = BigInt(Date.now());

  const record = Buffer.concat([
    bigUInt64BE(now), // timestamp
    Buffer.from([0x01]), // priority
    int32BE(25.2797 * 1e7), // longitude
    int32BE(54.6872 * 1e7), // latitude
    uint16BE(10), // altitude
    uint16BE(0), // angle
    Buffer.from([8]), // satellites
    uint16BE(0), // speed
    // IO element (Codec 8 Extended widths): event on AVL ID 239 (Ignition) = 1
    uint16BE(239), // event io id
    uint16BE(1), // N total
    uint16BE(1), // N1 count
    uint16BE(239), // N1 id
    Buffer.from([0x01]), // N1 value
    uint16BE(0), // N2 count
    uint16BE(0), // N4 count
    uint16BE(0), // N8 count
    uint16BE(0), // NX count
  ]);

  const dataField = Buffer.concat([
    Buffer.from([CODEC_8_EXTENDED]),
    Buffer.from([0x01]), // NOD1
    record,
    Buffer.from([0x01]), // NOD2
  ]);

  const crc = crc16ibm(dataField);
  const preamble = Buffer.alloc(4); // 0x00000000
  const dataFieldLength = uint32BE(dataField.length);
  const crcBuf = uint32BE(crc);

  return Buffer.concat([preamble, dataFieldLength, dataField, crcBuf]);
}

function crc16ibm(data: Buffer): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x0001) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

function uint16BE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function uint32BE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function int32BE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(n), 0);
  return b;
}
function bigUInt64BE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
}

const socket = net.createConnection({ host, port }, () => {
  console.log(`connected to ${host}:${port}, sending IMEI ${imei}`);
  socket.write(imeiHandshake(imei));
});

let step: "imei" | "data" = "imei";

socket.on("data", (chunk) => {
  if (step === "imei") {
    const accepted = chunk[0] === 0x01;
    console.log(accepted ? "IMEI accepted, sending AVL packet" : "IMEI rejected");
    if (!accepted) {
      socket.end();
      return;
    }
    step = "data";
    socket.write(buildSamplePacket());
    return;
  }

  console.log("server ack (records accepted):", chunk.readUInt32BE(0));
  socket.end();
});

socket.on("close", () => console.log("connection closed"));
socket.on("error", (err) => console.error("connection error:", err));
