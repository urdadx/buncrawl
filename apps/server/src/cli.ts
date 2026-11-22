import { parseArgs } from "node:util";

import {
  scrapeRequestSchema,
  type ScrapeDocument,
  type ScrapeRequest,
  type ScrapeResponse,
} from "@buncrawl/contracts";
import * as v from "valibot";

const USAGE = `Usage:
  buncrawl [serve]               Start the API server (configured by environment variables)
  buncrawl scrape <url> [opts]   Scrape one page and print it
  buncrawl <url> [opts]          Same as scrape

Scrape options:
  -f, --format <name>      markdown (default), html, rawHtml or links; repeat for several
      --render             Always render JavaScript in a browser
      --no-render          Never start a browser (plain HTTP)
      --screenshot <file>  Save a PNG screenshot (renders the page)
      --full-page          Keep navigation, headers and footers (default: main content only)
      --wait <ms>          Extra time to let the page settle after loading
      --timeout <ms>       Overall deadline (default 30000)
      --json               Print the full API response as JSON
  -h, --help               Show this help

One text format prints as-is; several formats, or --json, print JSON. Failures print to stderr
and exit 1 (with --json, the failure response goes to stdout). Browser rendering uses
Chrome (BUN_CHROME_PATH or PATH) and Lightpanda (BUNCRAWL_LIGHTPANDA_PATH or PATH) when present.`;

const TEXT_FORMATS = ["markdown", "html", "rawHtml", "links"] as const;
type TextFormat = (typeof TEXT_FORMATS)[number];

/** Where a parsed command line leads. */
export type CliCommand =
  | { kind: "serve" }
  | { kind: "help"; exitCode: number; message?: string }
  | { kind: "scrape"; request: ScrapeRequest; screenshotPath?: string; json: boolean };

/** Parses the arguments after the executable; never touches the environment or the network. */
export function parseCli(args: string[]): CliCommand {
  const [first, ...rest] = args;
  if (first === undefined || first === "serve") return { kind: "serve" };
  if (first === "-h" || first === "--help" || first === "help")
    return { kind: "help", exitCode: 0 };
  const scrapeArgs = first === "scrape" ? rest : /^https?:\/\//i.test(first) ? args : undefined;
  if (!scrapeArgs) return usageError(`Unknown command: ${first}`);

  let parsed;
  try {
    parsed = parseArgs({
      args: scrapeArgs,
      allowPositionals: true,
      allowNegative: true,
      options: {
        format: { type: "string", short: "f", multiple: true },
        render: { type: "boolean" },
        screenshot: { type: "string" },
        "full-page": { type: "boolean" },
        wait: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help", exitCode: 0 };
  if (positionals.length !== 1) return usageError("Pass exactly one URL to scrape");

  const formats = values.format ?? ["markdown"];
  const unknown = formats.find((format) => !TEXT_FORMATS.includes(format as TextFormat));
  if (unknown) return usageError(`Unknown format: ${unknown}`);
  if (values.screenshot !== undefined && values.render === false) {
    return usageError("--screenshot needs a browser; drop --no-render");
  }

  const input: Record<string, unknown> = {
    url: positionals[0],
    formats: values.screenshot === undefined ? formats : [...formats, "screenshots"],
  };
  if (values.render !== undefined) input.renderJs = values.render;
  if (values["full-page"]) input.onlyMainContent = false;
  for (const [option, field] of [
    ["wait", "waitForMs"],
    ["timeout", "timeout"],
  ] as const) {
    const value = values[option];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value)) return usageError(`--${option} takes milliseconds`);
    input[field] = Number(value);
  }

  const result = v.safeParse(scrapeRequestSchema, input);
  if (!result.success) return usageError(result.issues.map((issue) => issue.message).join("; "));
  return {
    kind: "scrape",
    request: result.output,
    ...(values.screenshot === undefined ? {} : { screenshotPath: values.screenshot }),
    json: values.json === true || formats.length > 1,
  };
}

/** What a scrape prints on stdout: the text of a single format, or JSON (always for failures). */
export function formatOutput(
  response: ScrapeResponse,
  command: Extract<CliCommand, { kind: "scrape" }>,
): string {
  if (command.json || !response.success) return `${JSON.stringify(response, null, 2)}\n`;
  const format = (command.request.formats ?? ["markdown"]).find(
    (entry): entry is TextFormat => typeof entry === "string" && entry !== "screenshots",
  );
  const value = format ? response.data[format as keyof ScrapeDocument] : undefined;
  if (Array.isArray(value)) return `${value.join("\n")}\n`;
  return typeof value === "string" ? `${value.replace(/\n*$/, "")}\n` : "";
}

export async function main(args: string[]): Promise<void> {
  const command = parseCli(args);
  if (command.kind === "serve") {
    await import("./index");
    return;
  }
  if (command.kind === "help") {
    if (command.message) console.error(`buncrawl: ${command.message}\n`);
    (command.exitCode === 0 ? console.log : console.error)(USAGE);
    process.exit(command.exitCode);
  }

  // Keep stdout for the result: browser workers log their timings to stderr instead.
  process.env.BUNCRAWL_RENDERER_LOGS = "stderr";
  const { scrape } = await import("@buncrawl/scrape");
  const response = await scrape(command.request);

  if (response.success && command.screenshotPath) {
    const match = /^data:image\/png;base64,(.+)$/.exec(response.data.screenshot ?? "");
    if (!match?.[1]) {
      console.error("buncrawl: the page was scraped, but no screenshot was captured");
      process.exit(1);
    }
    await Bun.write(command.screenshotPath, Uint8Array.fromBase64(match[1]));
    console.error(`Screenshot saved to ${command.screenshotPath}`);
    // Not repeated in the printed output.
    delete response.data.screenshot;
  }
  if (response.success && response.warning) console.error(`buncrawl: ${response.warning}`);
  if (!response.success && !command.json) {
    console.error(`buncrawl: ${response.code}: ${response.error}`);
    process.exit(1);
  }

  // Waits for the write: exiting with output still buffered for a pipe would drop it.
  await Bun.write(Bun.stdout, formatOutput(response, command));
  // Renderer and extraction workers would otherwise keep the process alive.
  process.exit(response.success ? 0 : 1);
}

function usageError(message: string): CliCommand {
  return { kind: "help", exitCode: 2, message };
}
