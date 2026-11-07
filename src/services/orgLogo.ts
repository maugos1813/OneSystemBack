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

/** The small copy of a logo for the map's plate tags: a few KB (the front makes it at upload), so a map with many fleets stays light. */
export const LOGO_TAG_MAX_CHARS = 30_000;

export const logoTagSchema = z
  .string()
  .max(LOGO_TAG_MAX_CHARS, "La versión pequeña del logo es demasiado grande")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, "El logo debe ser una imagen PNG, JPG o WebP");
