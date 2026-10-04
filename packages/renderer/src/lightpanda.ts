import type { RenderRequest, Renderer, RendererCapabilities, RenderResult } from "./renderer";

const DEFAULT_WAIT_MS = 2000;

interface LightpandaOutput {
  url?: unknown;
  http_status?: unknown;
  content?: unknown;
  error?: unknown;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (args: string[], signal: AbortSignal) => Promise<CommandResult>;

export interface LightpandaRendererOptions {
  executable?: string;
  waitMs?: number;
  proxyUrl?: string;
  runner?: CommandRunner;
}

export type LightpandaRendererErrorCode =
  | "LIGHTPANDA_UNAVAILABLE"
  | "LIGHTPANDA_RENDER_FAILED"
  | "LIGHTPANDA_INVALID_RESULT";

export class LightpandaRendererError extends Error {
  constructor(
    readonly code: LightpandaRendererErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LightpandaRendererError";
  }
}

export class LightpandaRenderer implements Renderer {
  readonly name = "lightpanda";

  private readonly executable: string;
  private readonly waitMs: number;
  private readonly runner: CommandRunner;
  private readonly customRunner: boolean;
  private readonly proxyUrl?: string;

  constructor(options: LightpandaRendererOptions = {}) {
    this.executable = options.executable ?? "lightpanda";
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.runner = options.runner ?? runCommand;
    this.customRunner = options.runner !== undefined;
    this.proxyUrl = options.proxyUrl;
  }

  capabilities(): RendererCapabilities {
    const available = this.customRunner || Bun.which(this.executable) !== null;
    return {
      available,
      browser: available,
      javascript: available,
      screenshots: available,
      cdp: false,
    };
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    if (!this.capabilities().available) {
      throw new LightpandaRendererError(
        "LIGHTPANDA_UNAVAILABLE",
        `Lightpanda executable not found: ${this.executable}`,
      );
    }
    if (request.deadline.signal.aborted || request.deadline.expired) {
      throw request.deadline.signal.reason ?? new Error("Render deadline expired");
    }

    const startedAt = performance.now();
    const htmlOutput = await this.fetch(request, "html");
    let screenshot: RenderResult["screenshot"];

    if (request.screenshot) {
      const pngOutput = await this.fetch(request, "png");
      screenshot = { data: pngOutput.content, mimeType: "image/png" };
    }

    return {
      sourceUrl: request.url,
      finalUrl: htmlOutput.url,
      title: extractTitle(htmlOutput.content),
      html: htmlOutput.content,
      renderer: this.name,
      elapsedMs: performance.now() - startedAt,
      ...(screenshot ? { screenshot } : {}),
    };
  }

  private async fetch(
    request: RenderRequest,
    dump: "html" | "png",
  ): Promise<{ url: string; content: string }> {
    const remainingMs = Math.max(1, Math.floor(request.deadline.remainingMs));
    const waitMs = Math.min(request.waitForMs ?? this.waitMs, remainingMs);
    const result = await this.runner(
      [
        this.executable,
        "fetch",
        request.url,
        "--dump",
        dump,
        "--json",
        "--wait-ms",
        String(waitMs),
        "--terminate-ms",
        String(remainingMs),
        "--block-private-networks",
        ...(this.proxyUrl ? ["--http-proxy", this.proxyUrl] : []),
      ],
      request.deadline.signal,
    );

    if (result.exitCode !== 0) {
      throw new LightpandaRendererError(
        "LIGHTPANDA_RENDER_FAILED",
        result.stderr.trim() || `Lightpanda exited with code ${result.exitCode}`,
      );
    }

    let output: LightpandaOutput;
    try {
      output = JSON.parse(result.stdout) as LightpandaOutput;
    } catch (cause) {
      throw new LightpandaRendererError(
        "LIGHTPANDA_INVALID_RESULT",
        "Lightpanda returned invalid JSON",
        { cause },
      );
    }

    if (
      output.error ||
      typeof output.url !== "string" ||
      typeof output.content !== "string" ||
      typeof output.http_status !== "number" ||
      output.http_status === 0
    ) {
      throw new LightpandaRendererError(
        "LIGHTPANDA_INVALID_RESULT",
        typeof output.error === "string" ? output.error : "Lightpanda returned an invalid result",
      );
    }
    return { url: output.url, content: output.content };
  }
}

async function runCommand(args: string[], signal: AbortSignal): Promise<CommandResult> {
  const subprocess = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const abort = () => subprocess.kill();
  signal.addEventListener("abort", abort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    if (signal.aborted) throw signal.reason ?? new Error("Render aborted");
    return { exitCode, stdout, stderr };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function extractTitle(html: string): string {
  return html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)?.[1]?.trim() ?? "";
}
