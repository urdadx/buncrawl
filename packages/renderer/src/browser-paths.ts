import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where browsers are commonly installed but usually not on `PATH`: macOS app bundles, Linux
 * system and snap paths, Windows program folders, and the Playwright browser cache. Searched
 * after `PATH`, in this order; only paths that exist and are executable are used.
 */
export interface BrowserLocations {
  chrome: readonly string[];
  lightpanda: readonly string[];
}

export function defaultBrowserLocations(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): BrowserLocations {
  return {
    chrome: [
      ...systemChromePaths(platform, home, env),
      ...playwrightChromePaths(platform, home, env),
    ],
    lightpanda:
      platform === "win32"
        ? []
        : [
            join(home, ".local", "bin", "lightpanda"),
            "/usr/local/bin/lightpanda",
            "/opt/homebrew/bin/lightpanda",
            "/usr/bin/lightpanda",
          ],
  };
}

/** The first location that is an executable file, or null. */
export function firstExecutable(locations: readonly string[]): string | null {
  for (const location of locations) {
    if (Bun.which(location)) return location;
  }
  return null;
}

function systemChromePaths(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    return [
      ...apps.map((app) => join("/Applications", app)),
      ...apps.map((app) => join(home, "Applications", app)),
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    return [
      "Google\\Chrome\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ].flatMap((exe) => roots.map((root) => `${root}\\${exe}`));
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
  ];
}

/** Playwright's downloaded Chromium builds, newest first: the headless shell, then full Chromium. */
function playwrightChromePaths(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    (platform === "darwin"
      ? join(home, "Library", "Caches", "ms-playwright")
      : platform === "win32"
        ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, "ms-playwright")
        : join(home, ".cache", "ms-playwright"));
  if (!cache) return [];
  const patterns =
    platform === "darwin"
      ? [
          "chromium_headless_shell-*/chrome-headless-shell-mac*/chrome-headless-shell",
          "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            "chromium_headless_shell-*/chrome-headless-shell-win*/chrome-headless-shell.exe",
            "chromium-*/chrome-win*/chrome.exe",
          ]
        : [
            "chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell",
            "chromium-*/chrome-linux*/chrome",
          ];
  return patterns.flatMap((pattern) => {
    try {
      return [
        ...new Bun.Glob(pattern).scanSync({ cwd: cache, absolute: true, onlyFiles: true }),
      ].sort((a, b) => buildNumber(b) - buildNumber(a));
    } catch {
      return [];
    }
  });
}

/** The Playwright build number in `.../chromium-1254/...`, so newer builds sort first. */
function buildNumber(path: string): number {
  return Number(/(?:chromium|chromium_headless_shell)-(\d+)/.exec(path)?.[1] ?? 0);
}
