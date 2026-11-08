import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Encrypts what must be readable later but never sit in the database in the clear (the authenticator secrets): AES-256-GCM.
 * The key is TOTP_ENCRYPTION_KEY when it is set; otherwise one derived from JWT_SECRET. Each ciphertext says which of the two
 * made it ("k2" explicit, "k1" derived), so setting the variable later doesn't strand the secrets already stored.
 */
function keyFor(kind: "k1" | "k2"): Buffer {
  if (kind === "k2") {
    if (!env.TOTP_ENCRYPTION_KEY) throw new Error("TOTP_ENCRYPTION_KEY is not configured but a secret was encrypted with it");
    return createHash("sha256").update(env.TOTP_ENCRYPTION_KEY).digest();
  }
  return Buffer.from(hkdfSync("sha256", env.JWT_SECRET, "onesystec", "totp-secret-box", 32));
}

export function encryptSecret(plain: string): string {
  const kind = env.TOTP_ENCRYPTION_KEY ? "k2" : "k1";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(kind), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [kind, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(box: string): string {
  const [kind, iv, tag, body] = box.split(".");
  if ((kind !== "k1" && kind !== "k2") || !iv || !tag || !body) throw new Error("Malformed secret");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(kind), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
