import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/services/secretBox.js";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "../../src/services/totp.js";

// RFC 6238, appendix B: the SHA-1 secret is the ASCII text "12345678901234567890" (the RFC lists 8 digits; we use the last 6).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("computes the codes of the RFC's own test vectors", () => {
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, expected] of vectors) expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  it("matches RFC 4226's HOTP vectors (the counter alone)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("round-trips base32, ignoring spaces, dashes, case and padding", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 77, 78]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode("gezd gnbv-GY3TQOJQ====")).toEqual(Buffer.from("1234567890"));
    expect(() => base32Decode("not*base32")).toThrow();
  });

  it("makes secrets of 160 bits, different every time", () => {
    const a = generateTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  describe("verifying", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);

    it("accepts the current code, and the one before and after (a phone's clock is never exact)", () => {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
    });

    it("refuses codes further away, wrong ones, and anything that isn't six digits", () => {
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, "000000", now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, "1234567", now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
    });

    it("accepts a code typed with a space in the middle (apps show it as '123 456')", () => {
      const code = hotp(RFC_SECRET, step);
      expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
    });

    it("refuses a code that was already used, and any older than the last one used", () => {
      const code = hotp(RFC_SECRET, step);
      expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step)).toBeNull();
      expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    });
  });

  it("builds the address a QR code carries, with the issuer and account escaped", () => {
    const uri = otpauthUri({ secret: "ABCDEF", account: "ana+prueba@x.it", issuer: "One Systec" });
    expect(uri.startsWith("otpauth://totp/One%20Systec:ana%2Bprueba%40x.it?")).toBe(true);
    const query = new URL(uri).searchParams;
    expect(query.get("secret")).toBe("ABCDEF");
    expect(query.get("issuer")).toBe("One Systec");
    expect(query.get("period")).toBe("30");
    expect(query.get("digits")).toBe("6");
  });
});

describe("the box the secrets are kept in", () => {
  it("returns what was put in, and never stores it in the clear", () => {
    const secret = generateTotpSecret();
    const box = encryptSecret(secret);
    expect(box).not.toContain(secret);
    expect(decryptSecret(box)).toBe(secret);
  });

  it("encrypts the same text differently each time", () => {
    expect(encryptSecret("ABC")).not.toBe(encryptSecret("ABC"));
  });

  it("refuses a box that was tampered with or is malformed", () => {
    const [kind, iv, tag, body] = encryptSecret("SECRET").split(".");
    const flipped = Buffer.from(body!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([kind, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
    expect(() => decryptSecret("nonsense")).toThrow();
  });
});
