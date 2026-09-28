import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const TICKET_TTL_SECONDS = 60;

/**
 * Short-lived, single-purpose ticket handed to an external product (e.g. Gamonal
 * Driver/Farmacy) so its own backend can log the user in without a password —
 * it only proves "this email just authenticated with OneSystec", nothing more.
 * Signed with a secret shared out-of-band with that product's backend, separate
 * from this app's own JWT_SECRET.
 */
export function createSsoTicket(params: { email: string; productKey: string }): string {
  if (!env.SSO_SHARED_SECRET) {
    throw new Error("SSO_SHARED_SECRET is not configured");
  }
  return jwt.sign({ email: params.email, product: params.productKey }, env.SSO_SHARED_SECRET, {
    algorithm: "HS256",
    expiresIn: TICKET_TTL_SECONDS,
  });
}
