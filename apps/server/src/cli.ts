import { parseArgs } from "node:util";

import {
  jobSubmissionSchema,
  scrapeRequestSchema,
  type ScrapeDocument,
  type ScrapeRequest,
  type ScrapeResponse,
} from "@buncrawl/contracts";
import * as v from "valibot";

import type { JobCommand, JobProgress } from "./cli-jobs";

const USAGE = `Usage:
  buncrawl [serve]                 Start the API server (configured by environment variables)
  buncrawl scrape <url> [opts]     Scrape one page and print it
  buncrawl <url> [opts]            Same as scrape; https:// is added when no scheme is given
  buncrawl map <url> [opts]        Discover a site's URLs and print one per line
  buncrawl crawl <url> [opts]      Scrape a site by following links; JSON Lines, or --out
  buncrawl batch <file|-> [opts]   Scrape the URLs in a file (one per line, - for stdin)

Page options (scrape, crawl, batch):
  -f, --format <name>      markdown (default), html, rawHtml or links; repeat for several
      --render             Always render JavaScript in a browser
      --no-render          Never start a browser (plain HTTP)
      --full-page          Keep navigation, headers and footers (default: main content only)
      --wait <ms>          Extra time to let each page settle after loading

Scrape options:
      --screenshot <file>  Save a PNG screenshot (renders the page)
      --timeout <ms>       Overall deadline (default 30000)
      --json               Print the full API response as JSON

Map and crawl options:
      --limit <n>          Most URLs to discover or pages to crawl (default 100)
      --depth <n>          Most links to follow from the start URL (default 10)
      --timeout <ms>       Deadline for the whole job (default 120000)
      --subdomains         Include the site's subdomains
      --path-prefix        Stay under the start URL's path

Crawl and batch options:
      --out <dir>          Write each page as Markdown into <dir> instead of printing JSON Lines
      --screenshots        Also save each page's screenshot into --out (renders every page)
      --page-timeout <ms>  Deadline for each page

Other options:
      --json               (map) Print the URLs as a JSON array
      --db <file>          Keep the job in this SQLite file instead of memory (large crawls)
  -h, --help               Show this help
  -v, --version            Print the version

Results go to stdout and progress to stderr. Failures exit 1, usage errors 2, Ctrl-C 130 after
printing what finished. Browser rendering uses Chrome and Lightpanda when installed: found on PATH
or in their usual install folders, or set with BUN_CHROME_PATH and BUNCRAWL_LIGHTPANDA_PATH.`;

// Replaced by `--define BUNCRAWL_VERSION=...` in release builds (scripts/build-release.sh).
declare const BUNCRAWL_VERSION: string | undefined;
export const VERSION = typeof BUNCRAWL_VERSION === "string" ? BUNCRAWL_VERSION : "dev";

const TEXT_FORMATS = ["markdown", "html", "rawHtml", "links"] as const;
type TextFormat = (typeof TEXT_FORMATS)[number];

/** Where a parsed command line leads. */
export type CliCommand =
  | { kind: "serve" }
  | { kind: "version" }
  | { kind: "help"; exitCode: number; message?: string }
  | { kind: "scrape"; request: ScrapeRequest; screenshotPath?: string; json: boolean }
  | {
      kind: "job";
      command: JobCommand;
      /** The POST body for /v1/map, /v1/crawl or /v1/batch/scrape; batch adds `requests`. */
      body: Record<string, unknown>;
      /** batch: the per-URL scrape options, and where to read the URLs from. */
      pageOptions?: Record<string, unknown>;
      source?: string;
      outDir?: string;
      json: boolean;
      dbPath?: string;
    };

const PAGE_OPTIONS = {
  format: { type: "string", short: "f", multiple: true },
  render: { type: "boolean" },
  "full-page": { type: "boolean" },
  wait: { type: "string" },
} as const;

const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
} as const;

/** Parses the arguments after the executable; never touches the environment or the network. */
export function parseCli(args: string[]): CliCommand {
  const [first, ...rest] = args;
  if (first === undefined || first === "serve") return { kind: "serve" };
  if (first === "-h" || first === "--help" || first === "help")
    return { kind: "help", exitCode: 0 };
  if (first === "-v" || first === "--version" || first === "version") return { kind: "version" };
  if (first === "map" || first === "crawl" || first === "batch") return parseJob(first, rest);
  const scrapeArgs = first === "scrape" ? rest : looksLikeUrl(first) ? args : undefined;
  if (!scrapeArgs) return usageError(`Unknown command: ${first}`);
  return parseScrape(scrapeArgs);
}

function parseScrape(args: string[]): CliCommand {
  const parsed = parse(args, {
    ...PAGE_OPTIONS,
    ...COMMON_OPTIONS,
    screenshot: { type: "string" },
    timeout: { type: "string" },
  });
  if ("kind" in parsed) return parsed;
  const { values, positionals } = parsed;
  const screenshotPath = values.screenshot as string | undefined;
  if (positionals.length !== 1) return usageError("Pass exactly one URL to scrape");
  if (screenshotPath !== undefined && values.render === false) {
    return usageError("--screenshot needs a browser; drop --no-render");
  }

  const page = pageOptions(values, screenshotPath !== undefined);
  if (typeof page === "string") return usageError(page);
  const url = urlArgument(positionals[0]!);
  if (!url) return usageError(`Not a URL: ${positionals[0]}`);
  const input: Record<string, unknown> = { url, ...page };
  const timeout = milliseconds(values.timeout as string | undefined, "timeout");
  if (typeof timeout === "string") return usageError(timeout);
  if (timeout !== undefined) input.timeout = timeout;

  const result = v.safeParse(scrapeRequestSchema, input);
  if (!result.success) return usageError(result.issues.map((issue) => issue.message).join("; "));
  return {
    kind: "scrape",
    request: result.output,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    // Several text formats cannot print as plain text.
    json: values.json === true || ((values.format as string[] | undefined)?.length ?? 1) > 1,
  };
}

function parseJob(command: JobCommand, args: string[]): CliCommand {
  const discovery = {
    limit: { type: "string" },
    depth: { type: "string" },
    timeout: { type: "string" },
    subdomains: { type: "boolean" },
    "path-prefix": { type: "boolean" },
  } as const;
  const pages = {
    ...PAGE_OPTIONS,
    out: { type: "string" },
    screenshots: { type: "boolean" },
    "page-timeout": { type: "string" },
  } as const;
  const parsed = parse(args, {
    ...COMMON_OPTIONS,
    db: { type: "string" },
    ...(command === "batch" ? {} : discovery),
    ...(command === "map" ? {} : pages),
  });
  if ("kind" in parsed) return parsed;
  const { values, positionals } = parsed;
  const what = command === "batch" ? "a file of URLs (or - for stdin)" : "exactly one URL";
  if (positionals.length !== 1) return usageError(`Pass ${what} to ${command}`);

  const outDir = values.out as string | undefined;
  if (values.screenshots && outDir === undefined) {
    return usageError("--screenshots saves PNG files, so it needs --out <dir>");
  }
  if (values.screenshots && values.render === false) {
    return usageError("--screenshots needs a browser; drop --no-render");
  }
  if (values.json && command !== "map") {
    return usageError(`${command} always prints JSON Lines; --json is for map`);
  }

  let page: Record<string, unknown> = {};
  if (command !== "map") {
    const options = pageOptions(values, values.screenshots === true);
    if (typeof options === "string") return usageError(options);
    page = options;
    if (outDir !== undefined && !(page.formats as unknown[]).includes("markdown")) {
      return usageError("--out writes Markdown files; include --format markdown");
    }
    const pageTimeout = milliseconds(values["page-timeout"] as string | undefined, "page-timeout");
    if (typeof pageTimeout === "string") return usageError(pageTimeout);
    if (pageTimeout !== undefined) page.timeout = pageTimeout;
  }

  const job = {
    kind: "job" as const,
    command,
    json: values.json === true,
    ...(outDir === undefined ? {} : { outDir }),
    ...(values.db === undefined ? {} : { dbPath: values.db as string }),
  };
  if (command === "batch") {
    // The URLs are read later; validate the shared options now with a placeholder.
    const check = validateJob("batch", { requests: [{ url: "https://example.com", ...page }] });
    if (check) return usageError(check);
    return { ...job, body: {}, pageOptions: page, source: positionals[0]! };
  }

  const url = urlArgument(positionals[0]!);
  if (!url) return usageError(`Not a URL: ${positionals[0]}`);
  const body: Record<string, unknown> = { url };
  const limitField = command === "map" ? "maxUrls" : "maxPages";
  for (const [option, field] of [
    ["limit", limitField],
    ["depth", "maxDepth"],
    ["timeout", "timeoutMs"],
  ] as const) {
    const value = values[option] as string | undefined;
    if (value === undefined) continue;
    if (!/^\d+$/.test(value)) return usageError(`--${option} takes a whole number`);
    body[field] = Number(value);
  }
  if (values.subdomains) body.includeSubdomains = true;
  if (values["path-prefix"]) body.pathPrefix = true;
  if (command === "crawl") body.scrapeOptions = page;
  const problem = validateJob(command, body);
  if (problem) return usageError(problem);
  return { ...job, body };
}

/** Builds the batch body from the URL list, or explains why it is unusable. */
export function batchBody(
  text: string,
  pageOptions: Record<string, unknown>,
): { body: Record<string, unknown> } | { error: string } {
  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (urls.length === 0) return { error: "No URLs to scrape (one per line; # starts a comment)" };
  const invalid = urls.find((url) => !urlArgument(url));
  if (invalid) return { error: `Not a URL: ${invalid}` };
  const body = { requests: urls.map((url) => ({ url: urlArgument(url)!, ...pageOptions })) };
  const problem = validateJob("batch", body);
  return problem ? { error: problem } : { body };
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
  if (command.kind === "version") {
    console.log(`buncrawl ${VERSION}`);
    return;
  }
  if (command.kind === "help") {
    if (command.message) console.error(`buncrawl: ${command.message}\n`);
    (command.exitCode === 0 ? console.log : console.error)(USAGE);
    process.exit(command.exitCode);
  }

  // Keep stdout for results: browser workers log their timings to stderr instead.
  process.env.BUNCRAWL_RENDERER_LOGS = "stderr";
  if (command.kind === "job") {
    process.exit(await runJobCommand(command));
  }

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

/** Runs map, crawl or batch in this process and prints the results; returns the exit code. */
async function runJobCommand(command: Extract<CliCommand, { kind: "job" }>): Promise<number> {
  let body = command.body;
  if (command.command === "batch") {
    const text = command.source === "-" ? await Bun.stdin.text() : await readFile(command.source!);
    if (text === undefined) {
      console.error(`buncrawl: cannot read ${command.source}`);
      return 2;
    }
    const built = batchBody(text, command.pageOptions ?? {});
    if ("error" in built) {
      console.error(`buncrawl: ${built.error}`);
      return 2;
    }
    body = built.body;
  }

  // First Ctrl-C cancels the job and prints what finished; a second one exits at once.
  let interrupted = false;
  const cancelled = new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      console.error("\nbuncrawl: stopping; Ctrl-C again to quit now");
      resolve();
    });
  });

  const { runJob, writePages } = await import("./cli-jobs");
  const progress = progressReporter(command.command);
  const result = await runJob(command.command, body, {
    cancelled,
    onProgress: progress.update,
    ...(command.dbPath === undefined ? {} : { dbPath: command.dbPath }),
  });
  progress.done();

  if (!result.ok) {
    console.error(`buncrawl: ${result.code}: ${result.error}`);
    for (const detail of result.details ?? []) console.error(`  ${detail}`);
    return result.status === 400 ? 2 : 1;
  }

  let output = "";
  if (command.command === "map") {
    output = command.json
      ? `${JSON.stringify(result.urls, null, 2)}\n`
      : result.urls.map((url) => `${url}\n`).join("");
  } else if (command.outDir !== undefined) {
    const written = await writePages(command.outDir, result.items);
    output = written.map((path) => `${path}\n`).join("");
  } else {
    // Pages that never ran (cancelled before their turn) carry no result.
    output = result.items
      .filter((item) => item.state === "completed" || item.state === "failed")
      .map((item) => `${JSON.stringify(item)}\n`)
      .join("");
  }
  await Bun.write(Bun.stdout, output);

  const { succeeded, failed } = result.progress;
  console.error(
    `buncrawl: ${command.command} ${result.state}: ${succeeded} succeeded, ${failed} failed`,
  );
  if (result.error) console.error(`buncrawl: ${result.error.code}: ${result.error.message}`);
  if (interrupted || result.state === "cancelled") return 130;
  return result.state === "completed" ? 0 : 1;
}

/** Progress on stderr: rewritten in place on a terminal, else a line every few seconds. */
function progressReporter(command: JobCommand) {
  const tty = process.stderr.isTTY === true;
  let last = "";
  let lastAt = 0;
  return {
    update(progress: JobProgress) {
      // Before the job has counted its first page there is nothing to report.
      if (progress.total === 0) return;
      const line = `${command}: ${progress.succeeded + progress.failed}/${progress.total} done${
        progress.failed ? `, ${progress.failed} failed` : ""
      }`;
      if (line === last) return;
      if (tty) {
        process.stderr.write(`\r\x1b[K${line}`);
      } else if (Date.now() - lastAt >= 5000) {
        process.stderr.write(`${line}\n`);
        lastAt = Date.now();
      }
      last = line;
    },
    done() {
      if (tty && last) process.stderr.write("\r\x1b[K");
    },
  };
}

type OptionSpec = Record<
  string,
  { type: "string" | "boolean"; short?: string; multiple?: boolean }
>;

function parse(
  args: string[],
  options: OptionSpec,
): CliCommand | { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, allowNegative: true, options });
    if (parsed.values.help) return { kind: "help", exitCode: 0 };
    return parsed;
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
}

/** The page-level scrape options shared by scrape, crawl and batch, or a usage error. */
function pageOptions(
  values: Record<string, unknown>,
  screenshot: boolean,
): Record<string, unknown> | string {
  const formats = (values.format as string[] | undefined) ?? ["markdown"];
  const unknown = formats.find((format) => !TEXT_FORMATS.includes(format as TextFormat));
  if (unknown) return `Unknown format: ${unknown}`;
  const page: Record<string, unknown> = {
    formats: screenshot ? [...formats, "screenshots"] : formats,
  };
  if (values.render !== undefined) page.renderJs = values.render;
  if (values["full-page"]) page.onlyMainContent = false;
  const wait = milliseconds(values.wait as string | undefined, "wait");
  if (typeof wait === "string") return wait;
  if (wait !== undefined) page.waitForMs = wait;
  return page;
}

function milliseconds(value: string | undefined, option: string): number | string | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : `--${option} takes milliseconds`;
}

function validateJob(command: JobCommand, body: Record<string, unknown>): string | undefined {
  const type = command === "batch" ? "batch_scrape" : command;
  const result = v.safeParse(jobSubmissionSchema, { ...body, type });
  return result.success ? undefined : result.issues.map((issue) => issue.message).join("; ");
}

async function readFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

/**
 * Adds `https://` to a URL typed without a scheme (`example.com/docs`). There is no fallback to
 * http: a page served only over plain HTTP needs an explicit `http://`.
 */
export function withScheme(input: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return input;
  return `https://${input.replace(/^\/\//, "")}`;
}

/**
 * A URL argument with its scheme: kept as typed when it has one (the request schema then rejects
 * anything but http and https), else `https://` plus a bare domain, which must contain a dot.
 * Undefined when a scheme-less argument is not a domain, e.g. a mistyped command.
 */
export function urlArgument(input: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return input;
  if (input.startsWith("-") || /\s/.test(input)) return undefined;
  const url = withScheme(input);
  try {
    return new URL(url).hostname.includes(".") ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A first argument that is a URL rather than a command. */
function looksLikeUrl(input: string): boolean {
  return (
    /^https?:\/\//i.test(input) ||
    (!/^[a-z][a-z\d+.-]*:\/\//i.test(input) && urlArgument(input) !== undefined)
  );
}

function usageError(message: string): CliCommand {
  return { kind: "help", exitCode: 2, message };
}
