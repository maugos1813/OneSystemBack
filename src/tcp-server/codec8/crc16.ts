/**
 * CRC-16/IBM (a.k.a. CRC-16/ARC): poly 0xA001 (reflected 0x8005), init 0x0000, no xorout.
 * This is the checksum Teltonika devices use to validate Codec 8 / Codec 8 Extended AVL packets.
 */
export function crc16ibm(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xffff;
}
