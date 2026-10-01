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
│   │               └── scrape.ts         # TODO: POST /v1/scrape handler
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
│   │       ├── detector.ts               # Decides when browser rendering is needed
│   │       ├── detector.test.ts
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
│   ├── scrape/                           # TODO: scrape orchestration
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
Bun.WebView render                                   |
       |                                             |
       +---------------------+-----------------------+
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
- Proxy-required browser rendering must never fall back to direct traffic.
- WebView uses ephemeral storage by default.
- Chrome proxy configuration is process-scoped and requires isolated Bun processes for different proxies.
- Browser availability is optional; HTTP-only scraping must still work without Chrome.

## Immediate Remaining Work

### 1. Scrape Orchestrator

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

### 2. Runtime Schemas

- Convert public scrape contracts into Valibot schemas.
- Infer TypeScript types from those schemas.
- Apply defaults for formats, timeout, main-content mode, and rendering mode.
- Reject unknown or invalid request values at the HTTP boundary.

### 3. HTTP Route

Implement `apps/server/src/routes/v1/scrape.ts`:

- Accept `POST /v1/scrape` JSON requests.
- Validate the body with Valibot.
- Create the request deadline.
- Cancel work when the client disconnects.
- Call the scrape orchestrator.
- Map known errors to stable HTTP statuses and response codes.
- Wire the route into `apps/server/src/index.ts`.

### 4. Browser Isolation

- Run WebView in dedicated Bun subprocesses instead of the API process.
- Add a bounded worker pool and request queue.
- Limit concurrent views per process.
- Recycle workers after crashes, timeouts, memory pressure, or a page-count limit.
- Use one proxy configuration per worker process.
- Add one fresh-process retry for browser crashes.

### 5. Browser Network Safety

- Validate browser redirects and subresource destinations through Chrome CDP events.
- Block requests to private, loopback, link-local, and metadata addresses.
- Ensure proxy-required requests fail closed.
- Add browser SSRF and redirect integration tests.

### 6. Extraction Quality

- Add a representative HTML-to-Markdown fixture corpus.
- Test tables, nested lists, code blocks, malformed HTML, entities, and large documents.
- Compare output against Firecrawl and fastCRW samples.
- Add readability/main-content fallback if HTMLRewriter cleanup is insufficient.

### 7. Linux Deployment

- Pin the Bun version in Docker.
- Install a pinned Chrome/Chromium build and required fonts/libraries.
- Set or verify `BUN_CHROME_PATH`.
- Add startup capability checks and `/v1/capabilities`.
- Run a real WebView smoke test in CI and the production image.

## Later Work

- SQLite-backed scrape, crawl, and batch jobs.
- Crawl frontier, robots.txt, sitemaps, deduplication, and per-host limits.
- Redis-backed distributed workers.
- `/v1/map`, `/v1/crawl`, and `/v1/batch/scrape`.
- Webhooks, SSE progress, and cancellation.
- MCP tools and SDKs.
- Optional Lightpanda and Playwright renderer backends.
- Firecrawl v2 compatibility adapter.
