import { Deadline } from "@buncrawl/core";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  rendererCapabilityReport,
  setRendererCapabilityReport,
  type BrowserRendererName,
  type RendererCapabilityReport,
} from "../src/capabilities";
import {
  createIsolatedDefaultRenderer,
  type IsolatedRendererConfig,
  type RendererWorker,
} from "../src/isolated";
import type { RendererCapabilities } from "../src/renderer";

const bin = await mkdtemp(join(tmpdir(), "buncrawl-default-renderer-"));
const lightpanda = join(bin, "lightpanda");
await Bun.write(lightpanda, "#!/bin/sh\nexit 0\n");
await chmod(lightpanda, 0o755);
const env = { PATH: bin, BUNCRAWL_LIGHTPANDA_PATH: lightpanda };

afterAll(() => rm(bin, { recursive: true, force: true }));
afterEach(() => setRendererCapabilityReport(undefined));

function capabilities(available: boolean): RendererCapabilities {
  return {
    available,
    browser: available,
    javascript: available,
    screenshots: available,
    cdp: false,
    computedStyles: false,
  };
}

function report(
  available: Partial<Record<BrowserRendererName, boolean>>,
): RendererCapabilityReport {
  const names: BrowserRendererName[] = ["lightpanda", "webview"];
  return {
    checkedAt: "2026-11-22T00:00:00.000Z",
    renderers: names.map((name) => ({
      name,
      executable: `/opt/${name}`,
      version: available[name] ? "1.0.0" : null,
      capabilities: capabilities(available[name] ?? false),
      ...(available[name] ? {} : { error: `${name} did not start` }),
    })),
    summary: capabilities(Object.values(available).some(Boolean)),
  };
}

/** Builds the default renderer with fake workers that record which browser each one would run. */
function recordingRenderer(checked: RendererCapabilityReport) {
  const spawned: IsolatedRendererConfig["type"][] = [];
  const workerFactory = (config: IsolatedRendererConfig): RendererWorker => {
    spawned.push(config.type);
    return {
      render: async (request) => ({
        result: {
          sourceUrl: request.url,
          finalUrl: request.url,
          title: config.type,
          html: `<html><body>${config.type}</body></html>`,
          renderer: config.type,
          elapsedMs: 1,
        },
        rssBytes: 1024,
      }),
      close() {},
    };
  };
  const renderer = createIsolatedDefaultRenderer({ env, report: checked, workerFactory });
  return { renderer, spawned };
}

describe("createIsolatedDefaultRenderer with a capability report", () => {
  test("leaves out a Chrome the report marks unavailable", async () => {
    const { renderer, spawned } = recordingRenderer(report({ lightpanda: true }));
    expect(renderer.name).toBe("isolated-lightpanda");
    const result = await renderer.render({
      url: "https://example.com/",
      deadline: new Deadline(1000),
    });
    expect(result.renderer).toBe("lightpanda");
    expect(spawned).toEqual(["lightpanda"]);
  });

  test("leaves out a Lightpanda the report marks unavailable", async () => {
    const { renderer, spawned } = recordingRenderer(report({ webview: true }));
    expect(renderer.name).toBe("isolated-webview");
    await renderer.render({ url: "https://example.com/", deadline: new Deadline(1000) });
    expect(spawned).toEqual(["webview"]);
  });

  test("is unavailable when the report marks every renderer unavailable", () => {
    const { renderer } = recordingRenderer(report({}));
    expect(renderer.capabilities()).toEqual(capabilities(false));
  });

  test("chains both renderers when both passed the check", () => {
    const { renderer } = recordingRenderer(report({ lightpanda: true, webview: true }));
    expect(renderer.name).toBe("renderer-chain");
    expect(renderer.capabilities().available).toBe(true);
  });
});

describe("rendererCapabilityReport", () => {
  test("returns the report set for this process", async () => {
    const checked = report({ webview: true });
    setRendererCapabilityReport(Promise.resolve(checked));
    expect(await rendererCapabilityReport()).toBe(checked);
    expect(rendererCapabilityReport()).toBe(rendererCapabilityReport());
  });
});
