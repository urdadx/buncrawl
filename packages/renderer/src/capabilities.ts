import { LightpandaRenderer, resolveLightpandaExecutable } from "./lightpanda";
import type { Renderer, RendererCapabilities } from "./renderer";
import { chromeLaunchArgs, resolveChromeExecutable, WebViewRenderer } from "./webview";

const CHECK_TIMEOUT_MS = 10_000;
/** A page each browser must load during the check; it needs no network. */
const PROBE_URL = "data:text/html,<title>probe</title><p>ok</p>";

export type BrowserRendererName = "lightpanda" | "webview";

export interface RendererBackendReport {
  name: BrowserRendererName;
  /** The browser executable this renderer launches; null when none was found. */
  executable: string | null;
  /** What the executable printed for its version command; null when the check failed. */
  version: string | null;
  capabilities: RendererCapabilities;
  /** Why the renderer is unavailable. */
  error?: string;
}

export interface RendererCapabilityReport {
  checkedAt: string;
  renderers: RendererBackendReport[];
  /** What scrapes can use across the available renderers, aggregated like `RendererChain`. */
  summary: RendererCapabilities;
}

/** Runs a command; resolves its trimmed stdout, or rejects when it fails or times out. */
export type CheckCommand = (args: string[]) => Promise<string>;

export interface RendererCapabilityCheckOptions {
  env?: Record<string, string | undefined>;
  run?: CheckCommand;
}

/**
 * Checks that each browser renderer can start here: its executable resolves, reports a version,
 * and loads a page with the flags renders use. A present but broken browser (wrong architecture,
 * missing shared libraries, no usable Chrome sandbox) is reported as unavailable instead of
 * failing on the first render.
 */
export async function checkRendererCapabilities(
  options: RendererCapabilityCheckOptions = {},
): Promise<RendererCapabilityReport> {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;

  const lightpandaPath = resolveLightpandaExecutable(env);
  const chromePath = resolveChromeExecutable(env);
  const renderers = await Promise.all([
    checkBackend({
      name: "lightpanda",
      executable: lightpandaPath,
      missing: `Lightpanda executable not found: ${env.BUNCRAWL_LIGHTPANDA_PATH || "lightpanda"}`,
      versionArgs: ["version"],
      launchArgs: ["fetch", PROBE_URL, "--dump", "html"],
      renderer: (executable) => new LightpandaRenderer({ executable, server: false }),
      run,
    }),
    checkBackend({
      name: "webview",
      executable: chromePath,
      missing: env.BUN_CHROME_PATH
        ? `BUN_CHROME_PATH is not an executable: ${env.BUN_CHROME_PATH}`
        : "No Chrome or Chromium executable found; set BUN_CHROME_PATH",
      versionArgs: ["--version"],
      launchArgs: [...chromeLaunchArgs(env), "--headless", "--dump-dom", PROBE_URL],
      renderer: (path) => new WebViewRenderer({ backend: "chrome", chrome: { path } }),
      run,
    }),
  ]);

  const available = renderers.filter((renderer) => renderer.capabilities.available);
  return {
    checkedAt: new Date().toISOString(),
    renderers,
    summary: {
      available: available.length > 0,
      browser: available.some((renderer) => renderer.capabilities.browser),
      javascript: available.some((renderer) => renderer.capabilities.javascript),
      screenshots: available.some((renderer) => renderer.capabilities.screenshots),
      cdp: available.some((renderer) => renderer.capabilities.cdp),
      computedStyles: available.some((renderer) => renderer.capabilities.computedStyles === true),
    },
  };
}

async function checkBackend(check: {
  name: BrowserRendererName;
  executable: string | null;
  missing: string;
  versionArgs: string[];
  launchArgs: string[];
  renderer(executable: string): Renderer;
  run: CheckCommand;
}): Promise<RendererBackendReport> {
  const { name, executable } = check;
  if (!executable) return unavailable(name, executable, null, check.missing);

  let version: string | null = null;
  try {
    version = (await check.run([executable, ...check.versionArgs])).split("\n")[0]!.trim();
    if (!version) throw new Error(`${executable} printed no version`);
    const page = await check.run([executable, ...check.launchArgs]);
    if (!page.includes("<p>ok</p>")) throw new Error(`${executable} did not render the probe page`);
  } catch (error) {
    return unavailable(
      name,
      executable,
      version,
      error instanceof Error ? error.message : `${error}`,
    );
  }
  const capabilities = check.renderer(executable).capabilities();
  if (!capabilities.available) {
    return unavailable(name, executable, version, "This Bun runtime has no Bun.WebView API");
  }
  return { name, executable, version, capabilities };
}

function unavailable(
  name: BrowserRendererName,
  executable: string | null,
  version: string | null,
  error: string,
): RendererBackendReport {
  return {
    name,
    executable,
    version,
    capabilities: {
      available: false,
      browser: false,
      javascript: false,
      screenshots: false,
      cdp: false,
      computedStyles: false,
    },
    error,
  };
}

async function runCommand(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode === 0 && !child.signalCode) return stdout.trim();

  // The last lines of stderr usually name the cause, e.g. a missing library or no usable sandbox.
  const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-2).join(" ").slice(0, 500);
  const outcome = child.signalCode
    ? `was killed by ${child.signalCode}`
    : `exited with code ${exitCode}`;
  throw new Error(`${args[0]} ${outcome}${detail ? `: ${detail}` : ""}`);
}
