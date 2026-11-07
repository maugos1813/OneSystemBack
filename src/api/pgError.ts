/**
 * The Postgres error code of a failed query, wherever the driver or the query builder put it: Drizzle wraps the database's own error
 * (the one that carries the code) as the `cause` of its "Failed query" error, so the code is not always on the error itself.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** unique_violation: that value (an email) is already taken. */
export const isUniqueViolation = (err: unknown): boolean => pgErrorCode(err) === "23505";

/** foreign_key_violation: it points at something that does not exist (a client that is not there). */
export const isForeignKeyViolation = (err: unknown): boolean => pgErrorCode(err) === "23503";
