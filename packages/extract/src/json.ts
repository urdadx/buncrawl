import type { JsonSelector, JsonSelectors } from "@buncrawl/contracts";
import { parseHTML } from "linkedom";

type ParsedDocument = ReturnType<typeof parseHTML>["document"];
type Scope = Pick<ParsedDocument, "querySelector" | "querySelectorAll">;
type Match = NonNullable<ReturnType<ParsedDocument["querySelector"]>>;

/** Bounds `all: true` lists so one selector cannot produce an unbounded response. */
export const MAX_JSON_MATCHES = 1000;

/**
 * Extracts structured values with CSS selectors from the full page (not the main-content cut,
 * so selectors can target any part of it). Missing matches are null; `all` lists may be empty.
 */
export function extractJson(html: string, selectors: JsonSelectors): Record<string, unknown> {
  return extractFields(parseHTML(html).document, selectors);
}

/** Returns why a selector is not valid CSS, or undefined when every selector parses. */
export function invalidJsonSelector(selectors: JsonSelectors): string | undefined {
  const { document } = parseHTML("<html><body></body></html>");
  for (const spec of Object.values(selectors)) {
    const field = normalize(spec);
    try {
      document.querySelector(field.selector);
    } catch {
      return `Invalid CSS selector: ${field.selector}`;
    }
    const nested = field.fields && invalidJsonSelector(field.fields);
    if (nested) return nested;
  }
}

function extractFields(scope: Scope, fields: JsonSelectors): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, spec]) => [name, extractField(scope, normalize(spec))]),
  );
}

function extractField(scope: Scope, field: Exclude<JsonSelector, string>): unknown {
  const read = (match: Match) =>
    field.fields
      ? extractFields(match, field.fields)
      : field.attribute
        ? (match.getAttribute(field.attribute) ?? null)
        : text(match);
  if (field.all) {
    return Array.from(scope.querySelectorAll(field.selector) as Iterable<Match>)
      .slice(0, MAX_JSON_MATCHES)
      .map(read);
  }
  const match = scope.querySelector(field.selector);
  return match ? read(match) : null;
}

function normalize(spec: JsonSelector): Exclude<JsonSelector, string> {
  return typeof spec === "string" ? { selector: spec } : spec;
}

function text(match: Match): string {
  return (match.textContent ?? "").replace(/\s+/g, " ").trim();
}
