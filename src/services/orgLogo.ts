import { z } from "zod";

/**
 * A client's logo, kept in the organization row as a data URL. The front shrinks it to a few tens of KB
 * before sending; this is the server's own limit. Only raster formats: an SVG can carry script.
 */
export const LOGO_MAX_CHARS = 350_000;

export const logoSchema = z
  .string()
  .max(LOGO_MAX_CHARS, "El logo es demasiado grande")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, "El logo debe ser una imagen PNG, JPG o WebP");
