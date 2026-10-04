import { Deadline } from "@buncrawl/core";
import { describe, expect, test } from "bun:test";

import { LightpandaRenderer, LightpandaRendererError } from "./lightpanda";

describe("LightpandaRenderer", () => {
  test("renders HTML through the Lightpanda CLI", async () => {
    const calls: string[][] = [];
    const renderer = new LightpandaRenderer({
      runner: async (args) => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: "https://example.com/final",
            http_status: 200,
            content: "<html><head><title>Rendered</title></head><body>Ready</body></html>",
            error: null,
          }),
          stderr: "",
        };
      },
    });

    const result = await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(5000),
      waitForMs: 250,
    });

    expect(result).toMatchObject({
      sourceUrl: "https://example.com",
      finalUrl: "https://example.com/final",
      title: "Rendered",
      renderer: "lightpanda",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--block-private-networks");
    expect(calls[0]).toContain("250");
  });

  test("captures a PNG when requested", async () => {
    const dumps = [
      {
        url: "https://example.com",
        http_status: 200,
        content: "<html><body>Ready</body></html>",
        error: null,
      },
      { url: "https://example.com", http_status: 200, content: "base64-png", error: null },
    ];
    const renderer = new LightpandaRenderer({
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(dumps.shift()),
        stderr: "",
      }),
    });

    const result = await renderer.render({
      url: "https://example.com",
      deadline: new Deadline(5000),
      screenshot: true,
    });

    expect(result.screenshot).toEqual({ data: "base64-png", mimeType: "image/png" });
  });

  test("reports command failures", async () => {
    const renderer = new LightpandaRenderer({
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "navigation failed" }),
    });

    const promise = renderer.render({
      url: "https://example.com",
      deadline: new Deadline(5000),
    });

    await expect(promise).rejects.toBeInstanceOf(LightpandaRendererError);
    await expect(promise).rejects.toThrow("navigation failed");
  });

  test("passes an upstream proxy without disabling private-network blocking", async () => {
    let command: string[] = [];
    const renderer = new LightpandaRenderer({
      proxyUrl: "http://user:secret@proxy.example:8080",
      runner: async (args) => {
        command = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: "https://example.com",
            http_status: 200,
            content: "<html></html>",
            error: null,
          }),
          stderr: "",
        };
      },
    });

    await renderer.render({ url: "https://example.com", deadline: new Deadline(1000) });

    expect(command).toContain("--block-private-networks");
    expect(command).toContain("--http-proxy");
    expect(command).toContain("http://user:secret@proxy.example:8080");
  });
});
