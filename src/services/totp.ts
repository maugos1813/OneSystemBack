import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) as Google Authenticator, Microsoft Authenticator, Authy and 1Password compute them:
 * HMAC-SHA1 over the 30-second counter, six digits. Written here (it is a page of code) instead of pulling a dependency into
 * the one place where a mistake means an open door.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes of the previous and next step are accepted too: a phone's clock is rarely exact to the second. */
const WINDOW_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, the size RFC 4226 recommends), as the base32 text the authenticator apps take. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one counter value (RFC 4226's HOTP). */
export function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code showing right now. */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  return hotp(secret, totpStep(nowMs));
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The step whose code this is (the current one, or one either side), or null if it's wrong. A step at or before
 * `lastUsedStep` is refused: a code that was already used (someone watching over a shoulder, a replayed request) is dead.
 */
export function verifyTotp(secret: string, code: string, nowMs: number = Date.now(), lastUsedStep: number | null = null): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Every step is compared, whatever the first answer, so the time taken doesn't say which one was close.
  for (let step = current - WINDOW_STEPS; step <= current + WINDOW_STEPS; step++) {
    if (sameText(hotp(secret, step), typed) && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** The otpauth:// address the QR code carries: the authenticator app reads the account, issuer and secret from it. */
export function otpauthUri(params: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
