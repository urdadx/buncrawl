import { Deadline } from "@buncrawl/core";

import type { IsolatedRendererConfig, WorkerRenderRequest } from "./isolated";
import { LightpandaRenderer } from "./lightpanda";
import type { Renderer } from "./renderer";
import { WebViewRenderer } from "./webview";

const config = parseConfig(process.env.BUNCRAWL_RENDERER_CONFIG);
const renderer: Renderer =
  config.type === "lightpanda"
    ? new LightpandaRenderer(config.options)
    : new WebViewRenderer(config.options);

process.on("message", async (message: unknown) => {
  if (!isWorkerRequest(message)) return;
  try {
    const request = message.request;
    const result = await renderer.render({
      url: request.url,
      deadline: new Deadline(request.timeoutMs),
      ...(request.waitForMs === undefined ? {} : { waitForMs: request.waitForMs }),
      ...(request.screenshot === undefined ? {} : { screenshot: request.screenshot }),
      ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
    });
    process.send?.({ id: message.id, result, rssBytes: process.memoryUsage().rss });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: {
        message: error instanceof Error ? error.message : "Browser render failed",
        ...(hasErrorCode(error) ? { code: error.code } : {}),
      },
    });
  }
});

function parseConfig(value: string | undefined): IsolatedRendererConfig {
  if (!value) throw new Error("Missing browser worker configuration");
  const parsed = JSON.parse(value) as IsolatedRendererConfig;
  if (parsed.type !== "lightpanda" && parsed.type !== "webview") {
    throw new Error("Invalid browser worker configuration");
  }
  return parsed;
}

function isWorkerRequest(value: unknown): value is { id: number; request: WorkerRenderRequest } {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { id?: unknown; request?: unknown };
  return typeof message.id === "number" && typeof message.request === "object";
}

function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}
