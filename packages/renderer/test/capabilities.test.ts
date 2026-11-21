import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRendererCapabilities } from "../src/capabilities";
import { isolatedRendererConfigs } from "../src/isolated";
import { resolveLightpandaExecutable } from "../src/lightpanda";
import { resolveChromeExecutable } from "../src/webview";

const bin = await mkdtemp(join(tmpdir(), "buncrawl-capabilities-"));
// Fake browsers: print a version for the version command, otherwise "render" the probe page.
const browser = (version: string, launch = 'echo "<html><body><p>ok</p></body></html>"') =>
  `case "$1" in version|--version) echo "${version}" ;; *) ${launch} ;; esac`;
const lightpanda = await script("lightpanda", browser("1.0.5"));
const chrome = await script("chrome-headless-shell", browser("Chromium 158.0.8127.36"));
const brokenChrome = await script(
  "broken-chrome",
  'echo "error while loading shared libraries: libnss3.so" >&2; exit 127',
);
const unsandboxedChrome = await script(
  "unsandboxed-chrome",
  browser(
    "Chromium 158.0.8127.36",
    'case " $* " in *" --no-sandbox "*) echo "<p>ok</p>" ;; *) echo "FATAL: No usable sandbox!" >&2; exit 133 ;; esac',
  ),
);

afterAll(() => rm(bin, { recursive: true, force: true }));

async function script(name: string, body: string): Promise<string> {
  const path = join(bin, name);
  await Bun.write(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("checkRendererCapabilities", () => {
  test("reports versions and per-renderer features when both browsers run", async () => {
    const report = await checkRendererCapabilities({
      env: { PATH: bin, BUNCRAWL_LIGHTPANDA_PATH: lightpanda, BUN_CHROME_PATH: chrome },
    });

    expect(report.renderers).toEqual([
      {
        name: "lightpanda",
        executable: lightpanda,
        version: "1.0.5",
        capabilities: {
          available: true,
          browser: true,
          javascript: true,
          screenshots: true,
          cdp: false,
          computedStyles: false,
        },
      },
      {
        name: "webview",
        executable: chrome,
        version: "Chromium 158.0.8127.36",
        capabilities: {
          available: true,
          browser: true,
          javascript: true,
          screenshots: true,
          cdp: true,
          computedStyles: true,
        },
      },
    ]);
    expect(report.summary).toEqual({
      available: true,
      browser: true,
      javascript: true,
      screenshots: true,
      cdp: true,
      computedStyles: true,
    });
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });

  test("a binary that cannot start is unavailable, with its error", async () => {
    const report = await checkRendererCapabilities({
      env: { PATH: bin, BUNCRAWL_LIGHTPANDA_PATH: lightpanda, BUN_CHROME_PATH: brokenChrome },
    });

    const webview = report.renderers.find((renderer) => renderer.name === "webview");
    expect(webview).toMatchObject({
      executable: brokenChrome,
      version: null,
      capabilities: { available: false, screenshots: false, cdp: false, computedStyles: false },
    });
    expect(webview?.error).toContain("exited with code 127");
    expect(webview?.error).toContain("libnss3.so");
    // Lightpanda still renders, but cannot measure branding or be guarded through CDP.
    expect(report.summary).toMatchObject({
      available: true,
      screenshots: true,
      cdp: false,
      computedStyles: false,
    });
  });

  test("a browser that starts but cannot load a page is unavailable", async () => {
    const env = { PATH: bin, BUN_CHROME_PATH: unsandboxedChrome };
    const sandboxed = await checkRendererCapabilities({ env });
    const webview = sandboxed.renderers.find((renderer) => renderer.name === "webview");
    expect(webview?.version).toBe("Chromium 158.0.8127.36");
    expect(webview?.capabilities.available).toBe(false);
    expect(webview?.error).toContain("No usable sandbox");

    // The same flags renders use, so the opt-out applies to the check as well.
    const unsandboxed = await checkRendererCapabilities({
      env: { ...env, BUNCRAWL_CHROME_NO_SANDBOX: "1" },
    });
    expect(unsandboxed.renderers.find((renderer) => renderer.name === "webview")).toMatchObject({
      capabilities: { available: true, cdp: true, computedStyles: true },
    });
  });

  test("missing executables are reported without running anything", async () => {
    const report = await checkRendererCapabilities({
      env: { PATH: join(bin, "empty"), BUN_CHROME_PATH: join(bin, "no-such-chrome") },
      run: () => Promise.reject(new Error("must not run")),
    });

    expect(
      report.renderers.map(({ name, executable, error }) => ({ name, executable, error })),
    ).toEqual([
      {
        name: "lightpanda",
        executable: null,
        error: "Lightpanda executable not found: lightpanda",
      },
      {
        name: "webview",
        executable: null,
        error: `BUN_CHROME_PATH is not an executable: ${join(bin, "no-such-chrome")}`,
      },
    ]);
    expect(report.summary.available).toBe(false);
  });
});

describe("browser configuration from the environment", () => {
  test("BUNCRAWL_LIGHTPANDA_PATH overrides the PATH lookup", () => {
    expect(resolveLightpandaExecutable({ PATH: bin })).toBe(lightpanda);
    expect(resolveLightpandaExecutable({ PATH: "", BUNCRAWL_LIGHTPANDA_PATH: lightpanda })).toBe(
      lightpanda,
    );
    expect(resolveLightpandaExecutable({ PATH: "" })).toBeNull();
  });

  test("BUN_CHROME_PATH must name an executable", () => {
    expect(resolveChromeExecutable({ PATH: "", BUN_CHROME_PATH: chrome })).toBe(chrome);
    expect(
      resolveChromeExecutable({ PATH: bin, BUN_CHROME_PATH: join(bin, "missing") }),
    ).toBeNull();
    expect(resolveChromeExecutable({ PATH: "" })).toBeNull();
  });

  test("workers get the Lightpanda path and the Chrome sandbox opt-out", () => {
    expect(
      isolatedRendererConfigs({
        PATH: "",
        BUNCRAWL_LIGHTPANDA_PATH: lightpanda,
        BUNCRAWL_CHROME_NO_SANDBOX: "1",
        BUNCRAWL_PROXY_URL: "http://proxy.example:8080",
      }),
    ).toEqual({
      lightpanda: {
        type: "lightpanda",
        options: { executable: lightpanda, proxyUrl: "http://proxy.example:8080" },
      },
      webview: {
        type: "webview",
        options: {
          backend: "chrome",
          chrome: { proxyUrl: "http://proxy.example:8080", argv: ["--no-sandbox"] },
        },
      },
    });
    expect(isolatedRendererConfigs({ PATH: "", BUNCRAWL_CHROME_NO_SANDBOX: "0" })).toEqual({
      webview: { type: "webview", options: { backend: "chrome" } },
    });
  });
});
