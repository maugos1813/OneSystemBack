/**
 * Real AVL frames from Teltonika's official Codec documentation
 * (https://wiki.teltonika-gps.com/view/Codec), reconstructed field-by-field from the
 * published breakdown tables and cross-checked programmatically (byte length, CRC-16,
 * decoded values, timestamps) against the same page, so the parser is validated
 * against ground truth rather than hand-crafted data.
 */

// Codec 8 — one record, one IO element of every width (1/2/4/8 bytes).
// GMT: Monday, June 10, 2019 10:04:46 AM. Server must ack with 00000001.
export const CODEC8_EXAMPLE_1_HEX =
  "000000000000003608010000016B40D8EA30010000000000000000000000000000000105" +
  "021503010101425E0F01F10000601A014E0000000000000000010000C7CF";
export const CODEC8_EXAMPLE_1_EXPECTED_ACK = 1;

// Codec 8 — one record, only 1-byte and 2-byte IO elements.
// GMT: Monday, June 10, 2019 10:05:36 AM. Server must ack with 00000001.
export const CODEC8_EXAMPLE_2_HEX =
  "000000000000002808010000016B40D9AD80010000000000000000000000000000000103" +
  "021503010101425E100000010000F22A";
export const CODEC8_EXAMPLE_2_EXPECTED_ACK = 1;

// Codec 8 — two records, each with a single 1-byte IO element (DIN1).
// Server must ack with 00000002.
export const CODEC8_EXAMPLE_3_HEX =
  "000000000000004308020000016B40D57B48010000000000000000000000000000000101" +
  "0101000000000000016B40D5C19801000000000000000000000000000000010101010100" +
  "0000020000252C";
export const CODEC8_EXAMPLE_3_EXPECTED_ACK = 2;

// Codec 8 Extended — one record with 1/2/4/8-byte IO elements (no variable-length ones).
// GMT: Monday, June 10, 2019 11:36:32 AM. Server must ack with 00000001.
export const CODEC8_EXTENDED_EXAMPLE_HEX =
  "000000000000004A8E010000016B412CEE00010000000000000000000000000000000001" +
  "0005000100010100010011001D00010010015E2C880002000B000000003544C87A000E00" +
  "0000001DD7E06A00000100002994";
export const CODEC8_EXTENDED_EXAMPLE_EXPECTED_ACK = 1;

export const SAMPLE_IMEI = "356307042441013";
// [2-byte length][ASCII IMEI], as sent by the device right after opening the TCP connection.
export const SAMPLE_IMEI_HANDSHAKE_HEX = "000F333536333037303432343431303133";
