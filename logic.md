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
│   │       ├── jobs.ts                   # Canonical async job contracts
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
- Browser screenshots wait for meaningful content and DOM quiet, giving shell-like SPAs a bounded hydration window; `waitForMs` provides an explicit delay for known slow applications.
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
- Chromium bounds concurrent URL and DNS validation so request interception does not serialize every page subresource into a network waterfall.
- Chromium traffic is forced through a worker-local proxy that connects to the exact validated IP while preserving the original TLS hostname.
- Safe WebView rendering requires Chromium; WebKit fails closed because it cannot intercept requests through CDP.
- `BUNCRAWL_PROXY_URL` routes Lightpanda or Chromium through an HTTP, HTTPS, SOCKS4, or SOCKS5 upstream proxy.
- Chromium chains through the worker-local safety proxy, which sends the validated destination IP upstream while preserving Host and TLS SNI.
- Rendered and fetched raw HTML resolve relative `href`, `src`, `action`, `formaction`, and `poster` attributes against the final URL and honor `<base href>`.
- Proxy-required browser rendering must never fall back to direct traffic.
- WebView uses ephemeral storage by default.
- Chrome proxy configuration is process-scoped and requires isolated Bun processes for different proxies.
- Browser availability is optional; HTTP-only scraping must still work without Lightpanda or Chrome.
- Main-content extraction compares deterministic cleanup with Readability and only accepts Readability when quality improves without excessive content loss.
- The current product target is self-hosted deployment; commercial multi-tenant infrastructure is deferred.
- Drizzle with libSQL is the persistence layer: a local SQLite file is the default and Turso is an optional remote database.
- SQLite/libSQL is authoritative for job state, results, cancellation, progress, and crawl-frontier state.
- Redis uses Bun's native client for dispatch, notifications, concurrency controls, and per-host rate limiting; Redis is not the authoritative job store.
- Docker Compose provisions Redis and persistent local data volumes so the default self-hosted installation requires no external services.
- Artifacts use Cloudflare R2 when fully configured and available, otherwise they use the local persistent artifact directory.
- Large raw HTML, Markdown, screenshots, and exports belong in artifact storage; SQLite stores their keys, metadata, sizes, and checksums.

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

### 10. Extraction Quality -> DONE

- DONE: Add a representative HTML-to-Markdown fixture corpus.
- DONE: Test tables, nested lists, code blocks, malformed HTML, entities, `srcset`, CSS URLs, and large documents.
- DONE: Compare output against Firecrawl and fastCRW samples.
- DONE: Add readability/main-content fallback if HTMLRewriter cleanup is insufficient.
- DONE: Score cleaned and Readability candidates using text retention, semantic coverage, structure, and link density.
- DONE: Protect card listings, multi-post forums, and reference-heavy articles from single-candidate content collapse.

### 11. Linux Deployment

- Pin the Bun version in Docker.
- Install pinned Lightpanda and Chrome/Chromium builds and required fonts/libraries.
- Set or verify `BUN_CHROME_PATH` and the Lightpanda executable path.
- Add startup capability checks and `/v1/capabilities`.
- Run real Lightpanda and WebView smoke tests in CI and the production image.

### 12. Durable Jobs, Batch, Map, and Crawl

Build this work in dependency order. The first vertical slice is a durable `/v1/batch/scrape` job running the existing `scrape()` operation. Crawl, map, events, compatibility, SDKs, and MCP build on the same job substrate.

#### 12.1 Runtime and Storage Boundaries

- Keep the self-hosted server compatible with `bun build --compile`.
- Use Drizzle schemas and migrations with the existing libSQL client.
- Default to `file:/data/buncrawl.db`; allow a Turso/libSQL URL and auth token as optional configuration.
- Add an artifact-store interface shared by jobs and synchronous routes.
- Implement an R2 backend with Bun's native S3 API.
- Implement a filesystem backend rooted at `/data/artifacts` by default.
- Select R2 only when its endpoint, bucket, access key, and secret are configured and the bucket passes a startup capability check; otherwise select the filesystem backend.
- Once R2 is selected for a process, retry and report runtime upload failures instead of silently splitting one job's artifacts between R2 and local storage.
- Use opaque, normalized artifact keys; never pass request-controlled paths directly to `Bun.file`, `Bun.Image`, or the S3 client.
- Store artifact metadata in SQLite: key, backend, content type, byte size, checksum, creation time, and optional expiration time.
- Preserve original screenshots. Use `Bun.Image` only for validation and optional previews, not as storage.
- Measure browser navigation, DOM settling, screenshot capture, extraction, and artifact-write latency separately before changing storage or renderer behavior.
- Do not treat a repeated URL as a cache key. Any scrape-result cache must be opt-in and key the normalized URL plus every output-affecting request option, with an explicit freshness policy.
- Keep artifact persistence outside the browser concurrency slot so slow filesystem or R2 writes do not reduce render throughput.

#### 12.2 Canonical Job Contracts -> DONE

- Add strict Valibot schemas for job submission, status, progress, results, cancellation, and errors.
- Define job types: `batch_scrape`, `map`, and `crawl` initially.
- Define states: `queued`, `running`, `completed`, `failed`, `cancelling`, and `cancelled`.
- Define terminal-state and cancellation semantics once for every job type.
- Assign stable job and item IDs, timestamps, counters, limits, and ordered event sequence numbers.
- Keep contracts Buncrawl-native; Firecrawl request and response translation remains a boundary adapter.

#### 12.3 Drizzle Job Schema and Repository -> DONE

- Add migrations and tables for `jobs`, `job_items`, `job_events`, and `artifacts`.
- Include request JSON, result/error metadata, progress counters, cancellation state, attempts, and timestamps.
- Include lease owner, lease expiration, and a monotonically increasing lease version on claimable work.
- Implement atomic enqueue, claim, heartbeat, completion, failure, cancellation request, and stale-lease recovery.
- Use explicit transactional or conditional SQL for claim and state-transition operations where ORM-generated queries are insufficient.
- Make completion idempotent and reject stale workers using the lease version.
- Do not tie an accepted job to the submitting HTTP request's abort signal.

#### 12.4 Local Worker and Redis Dispatch -> DONE

- Create `packages/jobs` with a bounded worker that invokes the existing `scrape()` function for each scrape item.
- Use a fresh per-attempt deadline and an `AbortController` connected to durable cancellation state.
- Persist progress and terminal state before acknowledging work.
- Recover expired running items after a process restart.
- Use Bun's native Redis client for immediate work notifications, worker coordination, and concurrency counters.
- Provision Redis with append-only persistence in Docker Compose.
- Keep database polling with backoff as the correctness fallback when Redis is unavailable.
- Send IDs through Redis, not complete requests, results, or authoritative state.

#### 12.5 First Vertical Slice: `/v1/batch/scrape`

- Implement `POST /v1/batch/scrape` to validate URLs and options, persist the job and items, notify workers, and return a job ID.
- Implement `GET /v1/batch/scrape/:id` to return status, progress, completed items, and stable errors.
- Implement `DELETE /v1/batch/scrape/:id` to request durable cancellation.
- Bound item concurrency and queue size.
- Support partial success without failing completed items.
- Write large outputs and screenshots through the artifact store while retaining small response metadata in SQLite.
- Test atomic claims, duplicate workers, partial failure, cancellation, stale-lease recovery, process restart, Redis absence, R2 selection, R2-unavailable filesystem fallback, and artifact-path safety.

#### 12.6 Crawl Foundation

- Add tables for `crawl_frontier` and `crawl_hosts`.
- Canonicalize HTTP(S) URLs and exclude `mailto:`, `tel:`, fragments, unsupported schemes, and out-of-scope URLs.
- Atomically deduplicate frontier entries across redirects and discovered links.
- Implement depth, page, byte, and elapsed-time limits.
- Retrieve, parse, cache, and enforce `robots.txt` by user agent.
- Parse sitemap and sitemap-index files with response-size, URL-count, and nesting limits.
- Enforce per-host concurrency, minimum delay, and robots crawl delay.
- Reuse URL/DNS safety, manual redirect validation, fetch response limits, extraction, and the job lease model.

#### 12.7 `/v1/map` Then `/v1/crawl`

- Implement `/v1/map` first to exercise discovery, scope, robots, sitemaps, deduplication, and host scheduling without storing every document.
- Implement `/v1/crawl` on the same frontier and execute `scrape()` for each accepted URL.
- Persist document metadata and artifact references without placing large bodies in queue messages.
- Expose submit, status, result, and cancellation routes using the canonical job contracts.
- Test redirects, duplicate canonical URLs, cyclic links, cross-origin scope, robots rules, sitemap indexes, host limits, cancellation, and restart recovery.

#### 12.8 Progress Events, SSE, and Webhooks

- Use `job_events` as the durable source for progress and state changes.
- Add SSE with snapshots, incremental events, heartbeats, sequence IDs, and `Last-Event-ID` resumption.
- Add signed webhooks with bounded retries and delivery records.
- Never make job completion depend on an SSE client or successful webhook delivery.
- Add cancellation and event-retention policies.

#### 12.9 Firecrawl v2 Compatibility

- Implement a thin adapter over canonical Buncrawl services and contracts.
- Translate scrape, batch, map, crawl, status, cancellation, errors, webhook events, and defaults explicitly.
- Do not change core job or document types merely to mimic Firecrawl field names.
- Document unsupported options and cover supported behavior with compatibility tests.

#### 12.10 SDKs and MCP

- Publish an OpenAPI description after the asynchronous APIs stabilize.
- Generate a TypeScript SDK first with polling, SSE, cancellation, and artifact-download helpers.
- Add other SDKs only when there is a concrete consumer.
- Implement MCP tools as thin SDK clients for scrape, batch scrape, map, crawl, job status, and cancellation.
- Do not create a second MCP-only execution path.

#### Step 12 Delivery Order

```text
storage boundaries
  -> job contracts
  -> Drizzle schema and repository
  -> local worker and Redis notifications
  -> /v1/batch/scrape
  -> crawl frontier, robots, sitemaps, and host scheduling
  -> /v1/map
  -> /v1/crawl
  -> SSE and webhooks
  -> Firecrawl v2 adapter
  -> SDKs and MCP
```

## Later Work

- Extraction quality phase 2:
  - Normalize complex tables with `rowspan`, `colspan`, ragged rows, and tables nested in lists.
  - Promote lazy-loaded `data-src` and `data-srcset` media attributes when canonical attributes are absent.
  - Replace comma splitting with standards-aware `srcset` parsing, including data URLs.
  - Expand boilerplate detection for breadcrumbs, newsletters, social controls, comments, modals, widgets, pagination, and sticky promotions.
  - Refine title recovery using visible headings, Open Graph metadata, and site-suffix removal.
  - Expose extraction strategy, candidate scores, retention ratio, and selection reason as diagnostics.
