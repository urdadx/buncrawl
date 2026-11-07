/** The string `code` an error carries (e.g. "BLOCKED_DESTINATION"), if any. */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
