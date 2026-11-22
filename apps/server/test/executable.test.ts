import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json";

// Builds the single-file executable with the `compile` script and runs it from an empty folder.
let dir: string;
let executable: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "buncrawl-executable-"));
  executable = join(dir, "server");
  const args = packageJson.scripts.compile.split(" ");
  args[args.indexOf("--outfile") + 1] = executable;
  const build = Bun.spawnSync(args, {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`compile failed: ${build.stderr.toString()}`);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Only what an operator would set; no .env.schema, .env or node_modules next to the binary. */
function serverEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    PORT: "0",
    CORS_ORIGIN: "http://localhost:3001",
    DATABASE_URL: `file:${join(dir, "data", "buncrawl.db")}`,
    BUNCRAWL_ARTIFACTS_PATH: join(dir, "data", "artifacts"),
    BUNCRAWL_LIGHTPANDA_PATH: "/nonexistent/lightpanda",
    BUN_CHROME_PATH: "/nonexistent/chrome",
  };
}

describe("compiled executable", () => {
  test("serves the API from plain environment variables", async () => {
    const child = Bun.spawn([executable], {
      cwd: dir,
      env: serverEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const url = await listeningUrl(child.stdout);
      const response = await fetch(new URL("/v1/capabilities", url));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { renderers: { name: string }[] } };
      expect(body.data.renderers.map((renderer) => renderer.name)).toEqual([
        "lightpanda",
        "webview",
      ]);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);

  test("becomes a browser worker when the renderer pool re-runs it", async () => {
    // The pool sets BUNCRAWL_RENDERER_CONFIG; the server's environment is not needed then.
    const child = Bun.spawn([executable], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", BUNCRAWL_RENDERER_CONFIG: '{"type":"unknown"}' },
      ipc() {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const output = (await child.stdout.text()) + (await child.stderr.text());
    expect(output).toContain("Invalid browser worker configuration");
    expect(output).not.toContain("Invalid environment variables");
  }, 30_000);

  test("runs CLI commands without any server configuration", async () => {
    const help = Bun.spawnSync([executable, "--help"], { cwd: dir, env: { PATH: "" } });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("buncrawl scrape <url>");

    const usage = Bun.spawnSync([executable, "scrape", "not-a-url"], {
      cwd: dir,
      env: { PATH: "" },
    });
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr.toString()).toContain("URL must be valid");
    expect(usage.stdout.toString()).toBe("");
  }, 30_000);

  test("refuses to start without the required environment variables", async () => {
    const child = Bun.spawn([executable], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    expect(await child.stderr.text()).toContain("DATABASE_URL: is required");
  }, 30_000);
});

async function listeningUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of stdout) {
    output += decoder.decode(chunk, { stream: true });
    const match = /Server listening at (\S+)/.exec(output);
    if (match) return match[1]!;
  }
  throw new Error(`The executable exited before listening:\n${output}`);
}
