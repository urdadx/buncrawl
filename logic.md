# Buncrawl Logic

## File Structure

```text
buncrawl/
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts                  # Bun.serve entry point
│   │       └── routes/
│   │           └── v1/
│   │               └── scrape.ts         # DONE: POST /v1/scrape handler
│   ├── web/                              # Dashboard
│   └── fumadocs/                         # Documentation site
│
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── index.ts
│   │       └── scrape.ts                 # Public scrape request/response types
│   │
│   ├── core/
│   │   └── src/
│   │       ├── index.ts
│   │       └── deadline.ts               # End-to-end request time budget
│   │
│   ├── security/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── url-safety.ts             # URL, DNS, IP, and redirect safety
│   │       └── url-safety.test.ts
│   │
│   ├── fetcher/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── fetch.ts                  # Native Bun HTTP fetch path
│   │       └── fetch.test.ts
│   │
│   ├── renderer/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── renderer.ts               # Replaceable renderer interface
│   │       ├── browser-safety.ts          # CDP request and DNS enforcement
│   │       ├── browser-safety.test.ts
│   │       ├── detector.ts               # Decides when browser rendering is needed
│   │       ├── detector.test.ts
│   │       ├── isolated.ts               # Bounded subprocess worker pool
│   │       ├── isolated.test.ts
│   │       ├── lightpanda.ts              # Lightpanda CLI renderer
│   │       ├── lightpanda.test.ts
│   │       ├── renderer-worker.ts         # Isolated renderer worker entry point
│   │       ├── safety-proxy.ts            # DNS-pinning Chromium proxy
│   │       ├── safety-proxy.test.ts
│   │       ├── webview.ts                # Bun.WebView Chrome/WebKit adapter
│   │       └── webview.test.ts
│   │
│   ├── extract/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── clean.ts                  # Bun HTMLRewriter cleanup
│   │       ├── metadata.ts               # Page metadata extraction
│   │       ├── links.ts                  # Link extraction and resolution
│   │       ├── markdown.ts               # Turndown + GFM conversion
│   │       ├── extract.ts                # Combined extraction entry point
│   │       └── extract.test.ts
│   │
│   ├── scrape/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── scrape.ts                 # DONE: scrape orchestration
│   │       └── scrape.test.ts
│   ├── jobs/                             # TODO: durable asynchronous jobs
│   ├── api/                              # Existing internal tRPC API
│   ├── db/                               # Existing Drizzle/libSQL package
│   └── ui/
│
├── bun-native-apis/                      # Local Bun API references
├── docker-compose.yml
└── logic.md
```

## Scrape Flow

```text
POST /v1/scrape
       |
       v
Validate request and create one Deadline
       |
       v
Validate URL and resolved IP addresses
       |
       v
Native Bun fetch with manual safe redirects
       |
       v
Detector classifies returned HTML
       |
       +---------------- sufficient ----------------+
       |                                             |
       | needs JavaScript                            |
       v                                             |
 Select renderer backend                             |
 Lightpanda when installed, otherwise Bun.WebView    |
 Run through bounded isolated worker pool            |
       |                                             |
       +---------------------+-----------------------+
                              |
                              v
              Resolve relative document URLs
                              |
                              v
              Clean HTML, metadata, links, Markdown
                             |
                             v
                    Build ScrapeResponse
```

## Current Rules

- Native HTTP fetch is always attempted first unless JavaScript is explicitly forced.
- `renderJs: false` must never start a browser.
- Every redirect must be URL and DNS validated before it is followed.
- One deadline covers validation, fetch, rendering, and extraction.
- A failed or empty browser result must not replace usable fetched content.
- Lightpanda is preferred when its executable is available; Bun.WebView is the availability fallback.
- A Lightpanda runtime failure triggers a Chromium attempt when WebView is available.
- Lightpanda output that fails quality checks escalates to Chromium within the same deadline.
- Lightpanda runs as a subprocess and inherits the request deadline and cancellation signal.
- Browser rendering runs in dedicated Bun worker subprocesses with one active view per worker.
- The worker pool bounds concurrency and queued requests, and recycles workers by page count or RSS.
- Cancellation terminates the active worker; worker and browser crashes receive one fresh-worker retry.
- Each worker is created with one immutable renderer and proxy configuration.
- Lightpanda browser requests use `--block-private-networks`.
- Chromium pauses every navigation and subresource through CDP and validates its URL and current DNS answers before continuing.
- Chromium traffic is forced through a worker-local proxy that connects to the exact validated IP while preserving the original TLS hostname.
- Safe WebView rendering requires Chromium; WebKit fails closed because it cannot intercept requests through CDP.
- `BUNCRAWL_PROXY_URL` routes Lightpanda or Chromium through an HTTP, HTTPS, SOCKS4, or SOCKS5 upstream proxy.
- Chromium chains through the worker-local safety proxy, which sends the validated destination IP upstream while preserving Host and TLS SNI.
- Rendered and fetched raw HTML resolve relative `href`, `src`, `action`, `formaction`, and `poster` attributes against the final URL and honor `<base href>`.
- Proxy-required browser rendering must never fall back to direct traffic.
- WebView uses ephemeral storage by default.
- Chrome proxy configuration is process-scoped and requires isolated Bun processes for different proxies.
- Browser availability is optional; HTTP-only scraping must still work without Lightpanda or Chrome.

## Immediate Remaining Work

### 1. Scrape Orchestrator -> DONE

Create `packages/scrape` and connect:

```text
fetchPage -> detectRenderNeed -> WebViewRenderer -> extractDocument
```

Requirements:

- Support `renderJs: false`, `true`, and `"auto"`.
- Preserve the fetched result if WebView fails or returns worse content.
- Request screenshots only when the format requires one.
- Map internal results into `ScrapeDocument`.
- Return structured warnings and error codes.
- Add static-page, SPA, forced-render, browser-failure, and timeout tests.

### 2. Runtime Schemas -> DONE

- Convert public scrape contracts into Valibot schemas.
- Infer TypeScript types from those schemas.
- Apply defaults for formats, timeout, main-content mode, and rendering mode.
- Reject unknown or invalid request values at the HTTP boundary.

### 3. HTTP Route -> DONE

Implement `apps/server/src/routes/v1/scrape.ts`:

- Accept `POST /v1/scrape` JSON requests.
- Validate the body with Valibot.
- Create the request deadline.
- Cancel work when the client disconnects.
- Call the scrape orchestrator.
- Map known errors to stable HTTP statuses and response codes.
- Wire the route into `apps/server/src/index.ts`.

### 4. Lightpanda Renderer -> DONE

- Implement the replaceable `LightpandaRenderer` using Lightpanda 1.0's `fetch` command.
- Prefer Lightpanda when installed and retain Bun.WebView as the availability fallback.
- Support rendered HTML and PNG screenshots.
- Propagate deadlines and cancellation to the subprocess.
- Block private-network browser requests.
- Reject command failures, malformed JSON, and zero-status navigation results.
- Add command-runner tests and a local real-binary smoke test.

### 5. Raw HTML URL Normalization -> DONE

- Resolve relative browser and fetch output URLs against the final page URL.
- Honor document `<base href>` values.
- Normalize asset, navigation, and form URL attributes without removing scripts or stylesheets.
- Apply normalization before extraction so `rawHtml`, cleaned HTML, and Markdown are consistent.

### 6. Server Request Timeout -> DONE

- Increase Bun's default 10-second server idle timeout for scrape requests.
- Keep the connection alive for the API's maximum 120-second scrape deadline.
- Add an integration test for a scrape that takes longer than 10 seconds.

### 7. Browser Isolation -> DONE

- Run WebView and Lightpanda adapters in dedicated Bun subprocesses instead of the API process.
- Bound the worker pool and pending request queue.
- Limit each worker to one active view.
- Recycle workers after crashes, cancellation, memory pressure, or a page-count limit.
- Keep one immutable renderer and proxy configuration per worker process.
- Retry browser and worker crashes once in a fresh process while preserving the original deadline.
- Test queue limits, worker reuse, page and RSS recycling, cancellation, and crash retry.

### 8. Browser Network Safety -> DONE

- Pause and validate Chromium navigation, redirect, and subresource requests through CDP `Fetch.requestPaused` events.
- Resolve every HTTP(S) request immediately before continuing it and block private, loopback, link-local, metadata, and invalid destinations.
- Re-resolve repeated hostnames instead of trusting a previous DNS result.
- Require Chromium for safe WebView rendering and fail closed when request interception is unavailable.
- Route Chrome proxy traffic without implicit loopback bypass and never retry it as a direct request.
- Use Lightpanda's `--block-private-networks` enforcement for its browser path.
- Test public requests, private destinations, metadata addresses, redirects, repeated DNS resolution, and unavailable interception.
- Route Chromium through a worker-local HTTP CONNECT proxy that resolves, validates, and pins every destination connection to the approved IP.
- Preserve the original hostname inside HTTPS tunnels so TLS certificate and SNI validation remain intact.
- Disable cross-target plain HTTP connection reuse and strip proxy credentials before forwarding.
- Chain HTTP, HTTPS, SOCKS4, and SOCKS5 upstream proxies using the validated destination IP.
- Support Basic authentication for HTTP/HTTPS and username/password authentication for SOCKS5.
- Fail closed when an upstream proxy is unavailable or rejects a connection; never retry through direct traffic.
- Bound direct, TLS, CONNECT, and SOCKS connection handshakes so a stalled proxy cannot consume the full render budget.
- Test pinned connections, private and metadata destinations, redirects, and DNS rebinding before upstream connection.

### 9. Renderer Reliability -> DONE

- Fall back to Bun.WebView when Lightpanda fails at runtime or returns inadequate content.
- Preserve one end-to-end deadline across all renderer attempts and never retry terminal URL-safety errors.
- Prefer WebView for screenshots because it captures HTML and PNG from one navigation; retain Lightpanda only as a last-resort screenshot backend.
- Expose the concrete `lightpanda` or `webview` renderer in response metadata.
- Return screenshots as directly usable `data:image/png;base64,...` URLs.
- Add opt-in real-site smoke tests for both backends with `BUNCRAWL_RUN_BROWSER_INTEGRATION=1`.

### 10. Extraction Quality

- Add a representative HTML-to-Markdown fixture corpus.
- Test tables, nested lists, code blocks, malformed HTML, entities, `srcset`, CSS URLs, and large documents.
- Compare output against Firecrawl and fastCRW samples.
- Add readability/main-content fallback if HTMLRewriter cleanup is insufficient.

### 11. Linux Deployment

- Pin the Bun version in Docker.
- Install pinned Lightpanda and Chrome/Chromium builds and required fonts/libraries.
- Set or verify `BUN_CHROME_PATH` and the Lightpanda executable path.
- Add startup capability checks and `/v1/capabilities`.
- Run real Lightpanda and WebView smoke tests in CI and the production image.

## Later Work

- SQLite-backed scrape, crawl, and batch jobs.
- Crawl frontier, robots.txt, sitemaps, deduplication, and per-host limits.
- Redis-backed distributed workers.
- `/v1/map`, `/v1/crawl`, and `/v1/batch/scrape`.
- Webhooks, SSE progress, and cancellation.
- MCP tools and SDKs.
- Firecrawl v2 compatibility adapter.
