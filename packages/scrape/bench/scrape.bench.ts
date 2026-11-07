/**
 * Scrape latency benchmark against real sites.
 *
 *   bun packages/scrape/bench/scrape.bench.ts [--runs 2] [--modes auto,render,screenshot]
 *     [--out results.json] [--compare base.json]
 *
 * Every URL is scraped `runs` times per mode ("auto", forced "render", and "screenshot", which uses
 * the WebView path), one at a time so measurements don't contend. Network conditions vary, so compare medians across runs, never
 * single samples.
 */
import type { ScrapeRequest } from "@buncrawl/contracts";

import { scrape, type ScrapeTimings } from "../src";

const URLS = [
  "https://example.com",
  "https://news.ycombinator.com",
  "https://en.wikipedia.org/wiki/Web_scraping",
  "https://developer.mozilla.org/en-US/docs/Web/HTML",
  "https://docs.python.org/3/",
  "https://ashesi.edu.gh",
  "https://www.firecrawl.dev",
  "https://react.dev",
  "https://bun.sh",
  "https://vercel.com",
  "https://github.com/oven-sh/bun",
  "https://www.bbc.com/news",
];
const ALL_MODES = ["auto", "render", "screenshot"] as const;
const PHASES = ["fetchMs", "detectMs", "renderMs", "extractMs", "totalMs"] as const;

type Sample = {
  url: string;
  mode: (typeof ALL_MODES)[number];
  run: number;
  success: boolean;
  code?: string;
  markdownLength: number;
  timings: ScrapeTimings;
};

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2)
  args.set(Bun.argv[i]!.replace(/^--/, ""), Bun.argv[i + 1]!);
const runs = Number(args.get("runs") ?? 2);
const MODES = (args.get("modes")?.split(",") ?? ["auto", "render"]).filter(
  (mode): mode is (typeof ALL_MODES)[number] => (ALL_MODES as readonly string[]).includes(mode),
);

const samples: Sample[] = [];
for (const mode of MODES) {
  for (const url of URLS) {
    for (let run = 1; run <= runs; run++) {
      let timings: ScrapeTimings = { totalMs: 0, renderer: "none" };
      const request: ScrapeRequest = {
        url,
        ...(mode === "render" ? { renderJs: true } : {}),
        ...(mode === "screenshot" ? { formats: ["markdown", "screenshots"] } : {}),
      };
      const response = await scrape(request, { onTimings: (value) => (timings = value) });
      const sample: Sample = {
        url,
        mode,
        run,
        success: response.success,
        ...(response.success ? {} : { code: response.code }),
        markdownLength: response.success ? (response.data.markdown?.length ?? 0) : 0,
        timings,
      };
      samples.push(sample);
      console.info(
        `${mode.padEnd(6)} #${run} ${pad(timings.totalMs, 7)}ms ${timings.renderer.padEnd(18)} ` +
          `${sample.success ? "ok " : (sample.code ?? "ERR").padEnd(3)} ${String(sample.markdownLength).padStart(7)} chars  ${url}`,
      );
    }
  }
}

console.info("\nMedian per phase (ms):");
const summary = summarize(samples);
for (const [key, row] of Object.entries(summary)) {
  console.info(
    `${key.padEnd(12)} ${PHASES.map((phase) => `${phase.replace("Ms", "")} ${pad(row[phase], 6)}`).join("  ")}  failures ${row.failures}`,
  );
}

const compareFile = args.get("compare");
if (compareFile) {
  const baseline = summarize((await Bun.file(compareFile).json()) as Sample[]);
  console.info(`\nChange vs ${compareFile} (median totalMs):`);
  for (const [key, row] of Object.entries(summary)) {
    const before = baseline[key]?.totalMs;
    if (before === undefined) continue;
    const delta = ((row.totalMs - before) / before) * 100;
    console.info(
      `${key.padEnd(12)} ${pad(before, 6)} → ${pad(row.totalMs, 6)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%)`,
    );
  }
}

const out = args.get("out");
if (out) {
  await Bun.write(out, JSON.stringify(samples, null, 2));
  console.info(`\nWrote ${samples.length} samples to ${out}`);
}
process.exit(0);

/** Groups samples by mode, and by cold (first) vs warm (later) runs. */
function summarize(all: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of all) {
    for (const key of [sample.mode, `${sample.mode}/${sample.run === 1 ? "cold" : "warm"}`]) {
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
  }
  return Object.fromEntries(
    [...groups].map(([key, group]) => [
      key,
      {
        ...Object.fromEntries(
          PHASES.map((phase) => [phase, median(group.map((sample) => sample.timings[phase] ?? 0))]),
        ),
        failures: group.filter((sample) => !sample.success).length,
      } as Record<(typeof PHASES)[number] | "failures", number>,
    ]),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function pad(value: number, width: number): string {
  return value.toFixed(0).padStart(width);
}
