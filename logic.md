# Buncrawl Logic

## File Structure

```text
buncrawl/
├── .github/workflows/server-image.yml    # DONE: builds the image and runs the browser smoke tests
├── apps/
│   ├── server/
│   │   ├── Dockerfile                    # DONE: pinned Bun, Chrome for Testing, Lightpanda, fonts
│   │   ├── scripts/smoke-image.sh        # DONE: offline smoke checks against a built image and its smoke target
│   │   └── src/
│   │       ├── index.ts                  # Bun.serve entry point
│   │       ├── executable.ts             # DONE: `pnpm compile` entry; server or browser worker
│   │       ├── env.server.ts             # Environment from .env.schema through varlock
│   │       ├── env.plain.ts              # DONE: the same variables from plain env, for the binary
│   │       └── routes/
│   │           ├── capabilities.ts       # DONE: GET /v1/capabilities
│   │           ├── v1/
│   │           │   └── scrape.ts         # DONE: POST /v1/scrape handler
│   │           └── v2/                   # DONE: Firecrawl v2 adapter over the v1 handlers
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
│   │   ├── test/
│   │   │   ├── browser-smoke.test.ts     # Real-browser smoke tests (BUNCRAWL_RUN_BROWSER_SMOKE=1)
│   │   │   └── fixtures/smoke.html       # Offline fixture page for the smoke tests
│   │   └── src/
│   │       ├── index.ts
│   │       ├── renderer.ts               # Replaceable renderer interface
│   │       ├── capabilities.ts           # Startup browser capability checks
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
│   ├── jobs/                             # Durable batch worker and artifact persistence
│   ├── crawl/                            # Crawl URLs, robots, sitemaps, discovery
│   ├── api/                              # Existing internal tRPC API
│   ├── db/                               # Drizzle over Bun's built-in SQLite
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
- In `renderJs: "auto"` mode, where a render must beat the fetched page, Lightpanda and Chromium start together when a Chromium worker is idle and the first accepted result wins; forced renders and screenshots stay sequential. Losing renders are left to finish within the deadline rather than killing their warm worker.
- The `branding` format measures a page's visual identity in Chromium: color scheme, brand name, logo, favicon and og:image, primary/secondary/accent and text colors, fonts and type scale, base spacing unit and corner radius, and primary/secondary button and input styles. An in-page script only samples computed styles; deterministic heuristics (no LLM) pick the values, and colors are hex, including ones the page declares in oklch. It needs a browser, so `renderJs: false` rejects it and Lightpanda, which does not compute styles, is never used for it. Field names follow Firecrawl's branding format. If styles cannot be read, the page still returns with the warning `Branding could not be measured`.
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
- Extraction runs on a bounded pool of Bun worker threads so parsing never blocks the event loop; a deadline terminates its worker, and extraction falls back to the main thread when workers cannot start.
- Scrape results are cached in SQLite only on request: a scrape is served from cache when the client sends `maxAge` (ms, up to 30 days) and a result at most that old exists; without `maxAge` it always scrapes fresh. Successful results are stored unless `storeInCache: false`. The cache key covers the URL and every option that changes the output; screenshot requests are never cached. Entries older than 30 days, and the oldest beyond 10,000 entries, are pruned hourly.
- The `json` format is selector-based, not LLM-based: `{ type: "json", selectors }` maps field names to CSS selectors (first match's text), or to `{ selector, attribute?, all?, fields? }` for attributes, lists (capped at 1,000 matches) and nested records. It runs in the extraction worker on the absolutized full page, missing matches are null, and invalid CSS fails the request before fetching.
- The current product target is self-hosted deployment; commercial multi-tenant infrastructure is deferred.
- Drizzle over Bun's built-in SQLite (`bun:sqlite`) is the persistence layer: one local database
  file. Remote databases (Turso/libSQL) are not supported; `DATABASE_URL` must be a `file:` URL.
- SQLite is authoritative for job state, results, cancellation, progress, and crawl-frontier state.
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

### 11. Linux Deployment -> DONE

- DONE: Pin the Bun version in Docker.
- DONE: Install pinned Lightpanda and Chrome/Chromium builds and required fonts/libraries.
- DONE: Set or verify `BUN_CHROME_PATH` and the Lightpanda executable path.
- DONE: Add startup capability checks and `/v1/capabilities`.
- DONE: Run real Lightpanda and WebView smoke tests in CI and the production image.

Decisions:

- `apps/server/Dockerfile` pins Bun (`oven/bun:1.4.2-slim`, Debian trixie), Chrome for Testing's
  `chrome-headless-shell` 158.0.8127.36 and Lightpanda 1.0.5 as build arguments, and verifies both
  downloads by SHA-256. Bump a version and its checksum together; CI runs the smoke tests against
  the result.
- Chrome for Testing has no arm64 Linux build, so the image is `linux/amd64` only and the build
  fails early on other architectures.
- `chrome-headless-shell` instead of full Chrome: it is the headless build Bun.WebView supports,
  needs no GTK, and renders, screenshots, and exposes CDP like Chrome. Locally, full Chrome
  155 captured 1280x713 viewport screenshots for a 1280x800 viewport; the image's shell captures
  the full 1280x800.
- Fonts: Liberation (metric-compatible with Arial, Times, Courier), DejaVu, Noto CJK, and Noto
  Color Emoji, so screenshots and computed-style branding see real glyphs for common Western,
  CJK, and emoji text. Noto CJK is the largest part of the image; it stays because scraped pages
  are often CJK.
- The build fails if `ldd` reports a missing library for either browser or if either cannot print
  its version.
- The image sets `BUN_CHROME_PATH=/opt/chrome/chrome-headless-shell` and
  `BUNCRAWL_LIGHTPANDA_PATH=/opt/lightpanda/lightpanda`. Outside the image both are optional:
  `BUNCRAWL_LIGHTPANDA_PATH` defaults to `lightpanda` on `PATH`, and Chrome is found the way Bun
  finds it. A `BUN_CHROME_PATH` that is not an executable now makes WebView unavailable instead
  of failing on the first render.
- Docker's default seccomp profile denies the user namespaces Chrome's sandbox needs ("No usable
  sandbox"), so the image sets `BUNCRAWL_CHROME_NO_SANDBOX=1`, which adds `--no-sandbox` to every
  Chrome launch. The containment that remains is: the image's unprivileged `bun` user, one browser
  per worker process, the CDP request guard, and the DNS-pinning safety proxy. Set it to `0` where
  the container may create user namespaces.
- The server image's entrypoint starts as root only to create `/data` and, when anything in it
  belongs to another user, `chown -R` it to `bun` (UID 1000). It then drops to `bun` with
  `setpriv`. A bind-mounted `./.data` therefore works whichever host user created it, including
  data written as root by earlier images. A container started with `--user` skips that step.
- At startup the server checks each renderer: its executable resolves, prints a version, and
  loads a `data:` probe page with the same flags renders use. This catches missing libraries and
  a missing sandbox before the first render. `GET /v1/capabilities` returns that report
  (`renderers[]` with the executable, version, error, and the existing `RendererCapabilities`,
  plus a `summary` aggregated like `RendererChain`). Unavailable renderers log a warning;
  HTTP-only scraping still works.
- Smoke tests (`packages/renderer/test/browser-smoke.test.ts`, run with
  `BUNCRAWL_RUN_BROWSER_SMOKE=1`) render `test/fixtures/smoke.html` as a `data:` URL through the
  isolated worker pool with the production worker configuration. They check that scripts run,
  the screenshot decodes and contains drawn text, branding colors and fonts are measured, and
  neither browser contacts a loopback service. The network guards block every private address,
  so a local HTTP fixture server cannot be rendered, and `data:` URLs keep the tests offline.
  Lightpanda's server mode now reports status 200 for `data:` documents, as `lightpanda fetch`
  does.
- The image runs the single-file binary (`pnpm --filter server compile`, see 12.1) instead of the
  workspace and its `node_modules`. The builder fetches every locked package from
  `pnpm-lock.yaml` alone into a store layer, so a source change only re-links the server's
  production dependencies offline and recompiles. The server build needs no `.env` secrets.
- The Dockerfile's `smoke` target is the runtime image plus the renderer sources and their
  production dependencies. `apps/server/scripts/smoke-image.sh <image> <smoke-image>` runs the
  smoke tests in the `smoke` image, then starts the deployable image and requires
  `/v1/capabilities` to report both renderers with every feature.
  `.github/workflows/server-image.yml` builds both targets with the GitHub Actions cache and runs
  that script on every push to `main` and every pull request.

### 12. Durable Jobs, Batch, Map, and Crawl

Build this work in dependency order. The first vertical slice is a durable `/v1/batch/scrape` job running the existing `scrape()` operation. Crawl, map, events, compatibility, SDKs, and MCP build on the same job substrate.

#### 12.1 Runtime and Storage Boundaries

- DONE: API keys. `BUNCRAWL_API_KEY` holds one or more comma-separated keys (16+ characters each).
  When set, every endpoint except `GET /` and the dashboard's `/trpc` health query requires
  `Authorization: Bearer <key>` and answers `401 UNAUTHORIZED` otherwise; CORS preflight stays
  open. Keys are compared as SHA-256 digests with `timingSafeEqual`, against every configured
  key. Unset, the API stays open and the server warns at startup. `endpoint(handler, { public })`
  in `apps/server/src/http.ts` is the only place routes opt out.

- Keep the self-hosted server compatible with `bun build --compile`. DONE: `pnpm --filter server compile`
  builds `apps/server/server`, which runs from any folder with plain environment variables and
  renders with Lightpanda and Chrome:
  - An executable runs only its embedded entry point, whatever its arguments. The renderer pool
    therefore re-runs the executable itself, and `src/executable.ts` loads the browser worker
    instead of the server when `BUNCRAWL_RENDERER_CONFIG` is set.
  - `src/extract-worker.ts` is a second compile entry point, embedded beside the main module under
    `/$bunfs/root/`. Inside an executable `import.meta.url` still names the source file on the
    build machine, so both pools detect the executable from `Bun.main` instead.
  - The `buncrawl-executable` build condition maps `#env` to `src/env.plain.ts`, which validates
    the `.env.schema` variables from `process.env` with valibot. varlock resolves the schema through
    its CLI, which a lone binary has neither. The binary requires `DATABASE_URL` and
    `BUNCRAWL_ARTIFACTS_PATH` instead of using the schema's development paths, and does not redact
    secrets from console output as varlock does. A test keeps the two variable lists in step.
  - `--format=esm` keeps top-level await (the renderer worker uses it) working with `--bytecode`.
  - `apps/server/test/executable.test.ts` compiles the binary and checks both entry modes.
  - DONE: zero configuration. The binary defaults `DATABASE_URL` and `BUNCRAWL_ARTIFACTS_PATH`
    to `./data` (the image sets `/data`), and `CORS_ORIGIN` to `*` everywhere (keys travel in a
    header, not cookies). Redis is opt-in: without `REDIS_URL`, `RedisJobDispatch` creates no
    clients and workers rely on polling; the compose stack no longer runs Redis.
  - DONE: CLI jobs. `buncrawl map|crawl|batch` (`src/cli-jobs.ts`) open a private SQLite
    database (memory, or `--db <file>`), start the server's `DiscoveryWorker` or `JobWorker`, and
    drive the job through the v1 route handlers in-process: POST to submit, GET with a cursor to
    page results, DELETE when Ctrl-C cancels. Validation, limits and result shapes therefore
    match the API. Flags are checked against `jobSubmissionSchema` before any work starts.
    Output: URLs (map), JSON Lines of items that ran (crawl, batch), or Markdown and PNG files
    with URL-derived names restricted to `[A-Za-z0-9._-]` (`--out`). Documents stay inline in
    the job database; the CLI has no artifact store.
  - DONE: releases. A `v*` tag runs `.github/workflows/release.yml`: `scripts/build-release.sh`
    cross-compiles linux and darwin, x64 and arm64, stamps `--version` through
    `--define BUNCRAWL_VERSION`, and publishes `buncrawl-<os>-<arch>.tar.gz` plus `SHA256SUMS`.
    `install.sh` installs one, refusing a checksum mismatch, without sudo. The image workflow
    pushes `ghcr.io/<repo>` after the smoke tests: `main` and `sha-*` from main, the version and
    `latest` from tags. Windows and musl Linux are not built yet.
  - DONE: CLI. `src/cli.ts` makes the binary `buncrawl [serve]` (the default, so Docker is
    unchanged) or `buncrawl [scrape] <url> [options]`, which runs `scrape()` in-process with no
    database, Redis or server env. Options map onto the v1 scrape request and are validated by
    `scrapeRequestSchema`. Results go to stdout; browser worker timings and errors go to stderr
    (`BUNCRAWL_RENDERER_LOGS=stderr`). The entry point awaits the command: with a floating
    `import()` promise Bun exited mid-fetch with no output.
- Use Drizzle schemas and migrations over `bun:sqlite`.
- Default to `file:/data/buncrawl.db`. DONE: Turso/libSQL support removed (the remote client,
  `DATABASE_AUTH_TOKEN`, `@libsql/client` and the unused `libsql` dependency); drizzle-kit uses
  Bun's or Node's built-in SQLite driver.
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

#### 12.5 First Vertical Slice: `/v1/batch/scrape` -> DONE

- Implement `POST /v1/batch/scrape` to validate URLs and options, persist the job and items, notify workers, and return a job ID.
- Implement `GET /v1/batch/scrape/:id` to return status, progress, completed items, and stable errors; page items with `cursor`/`limit` and a `next` URL so large batches do not inflate status polls.
- Implement `DELETE /v1/batch/scrape/:id` to request durable cancellation.
- Bound item concurrency and queue size.
- Support partial success without failing completed items.
- Write large outputs and screenshots through the artifact store while retaining small response metadata in SQLite.
- Test atomic claims, duplicate workers, partial failure, cancellation, stale-lease recovery, process restart, Redis absence, R2 selection, R2-unavailable filesystem fallback, and artifact-path safety.

#### 12.6 Crawl Foundation -> DONE

- Add tables for `crawl_frontier` and `crawl_hosts`.
- Canonicalize HTTP(S) URLs and exclude `mailto:`, `tel:`, fragments, unsupported schemes, and out-of-scope URLs.
- Atomically deduplicate frontier entries across redirects and discovered links.
- Implement depth, page, byte, and elapsed-time limits. A page's depth is the number of path
  segments below the start URL (`/events/` under `/` is 1; pages outside the start path are 0), the
  same for sitemap and linked pages, so `maxDepth` (default 10) limits both.
- Retrieve, parse, cache, and enforce `robots.txt` by user agent.
- Parse sitemap and sitemap-index files with response-size, decompression, URL-count, and nesting limits; fetch sibling files with bounded concurrency and interleave capped results across leaves.
- Enforce per-host concurrency, minimum delay, and robots crawl delay.
- Reuse URL/DNS safety, manual redirect validation, fetch response limits, extraction, and the job lease model.

#### 12.7 `/v1/map` Then `/v1/crawl` -> DONE

- Implement `/v1/map` first to exercise discovery, scope, robots, sitemaps, deduplication, and host scheduling without storing every document.
- Implement `/v1/crawl` on the same frontier and execute `scrape()` for each accepted URL.
- Persist document metadata and artifact references without placing large bodies in queue messages.
- Expose submit, status, result, and cancellation routes using the canonical job contracts.
- Test redirects, duplicate canonical URLs, cyclic links, cross-origin scope, robots rules, sitemap indexes, host limits, cancellation, and restart recovery.

#### 12.8 Progress Events, SSE, and Webhooks -> DONE

- Use `job_events` as the durable source for progress and state changes.
- Add SSE with snapshots, incremental events, heartbeats, sequence IDs, and `Last-Event-ID` resumption.
- Add signed webhooks with bounded retries and delivery records.
- Never make job completion depend on an SSE client or successful webhook delivery.
- Add cancellation and event-retention policies.

SSE: `GET /v1/batch/scrape/:id/events`, `/v1/map/:id/events`, or `/v1/crawl/:id/events`.
New connections receive a snapshot, then ordered persisted events. Resume with `Last-Event-ID`
(or `?after=<sequence>`); event IDs are per-job sequence numbers. Streams close after the
terminal event; heartbeats are SSE comments. Client disconnects stop only the stream, not the job.

Optional submission field: `"webhook": { "url": "https://...", "secret": "..." }`
(secret minimum 16 characters). An optional `events` array selects `state_changed`,
`progress`, `item_completed`, `page_completed`, and/or `error` events; omitting it delivers all
events. `item_completed` (`itemId`, `index`) is emitted per batch-scrape item; map and crawl jobs
instead emit `page_completed` (`url`, `depth`, `state` of `completed` or `failed`, plus `finalUrl`
after a redirect and `error` on failure) once per fetched page.
Each selected durable event is delivered as JSON with
`X-Buncrawl-Delivery: <jobId>:<sequence>`, `X-Buncrawl-Timestamp` (Unix milliseconds), and
`X-Buncrawl-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`.
Verify the signature against the unmodified body and deduplicate by delivery ID. URLs must
use HTTPS; delivery pins the validated public IP for TLS while preserving the hostname.
Delivery retries at most five times with exponential backoff and records status/attempts in
`webhook_deliveries`. Cancellation emits state events and does not cancel already queued
webhook deliveries. Terminal job events are retained seven days, delivery records fourteen
days; pending deliveries keep their events until resolved.

#### 12.9 Firecrawl v2 Compatibility -> DONE

- Implement a thin adapter over canonical Buncrawl services and contracts.
- Translate scrape, batch, map, crawl, status, cancellation, errors, webhook events, and defaults explicitly.
- Do not change core job or document types merely to mimic Firecrawl field names.
- Document unsupported options and cover supported behavior with compatibility tests.

`apps/server/src/routes/v2/translate.ts` translates requests and responses; the v2 handlers pass
each translated request to the canonical v1 handler and translate its response back, so
validation, queueing, storage, and limits stay canonical.

| Firecrawl v2                             | Canonical                                               |
| ---------------------------------------- | ------------------------------------------------------- |
| `POST /v2/scrape`                        | `POST /v1/scrape`                                       |
| `POST /v2/batch/scrape`                  | `POST /v1/batch/scrape` (`urls` -> `requests`)          |
| `GET`/`DELETE /v2/batch/scrape/:id`      | `GET`/`DELETE /v1/batch/scrape/:id`                     |
| `GET /v2/batch/scrape/:id/errors`        | failed items across every result page                   |
| `POST /v2/crawl`                         | `POST /v1/crawl`                                        |
| `GET`/`DELETE /v2/crawl/:id`             | `GET`/`DELETE /v1/crawl/:id`                            |
| `GET /v2/crawl/:id/errors`               | failed pages; `ROBOTS_BLOCKED` ones go to `robotsBlocked` |
| `POST /v2/map` (synchronous)             | a `/v1/map` job, awaited, then all its URLs as `links`  |

- Formats: `markdown`, `html`, `rawHtml`, `links` and `branding` (string or `{ type }`) map
  one to one; `screenshot` maps to the canonical screenshot object with `fullPage` and
  `viewport`. Branding's `mode` is accepted and ignored, as Firecrawl does.
- Options: `waitFor` -> `waitForMs`; `timeout`, `onlyMainContent`, `maxAge`, `storeInCache` pass
  through. Crawl `limit` -> `maxPages`, `allowSubdomains` -> `includeSubdomains`,
  `crawlEntireDomain` -> `pathPrefix: !crawlEntireDomain`, `scrapeOptions` translated as above.
  Map `limit` -> `maxUrls`, `includeSubdomains` (or `allowSubdomains`) passes through, `timeout`
  -> `timeoutMs`.
- Firecrawl defaults are applied explicitly: formats `["markdown"]`, `onlyMainContent: true`,
  crawl `limit` 10000, map `limit` 5000, map `includeSubdomains: true`.
- Documents: `metadata.finalURL` -> `metadata.url`, `proxyUsed: "basic"`, `renderer` is dropped,
  and a scrape warning is set on both the response and `data.warning`. Branding passes through
  unchanged because the canonical profile already uses Firecrawl's field names.
- Status: `queued`, `running`, and `cancelling` -> `scraping`; `completed`, `failed`,
  `cancelled` are unchanged. `completed`/`creditsUsed` are the succeeded count, `total` the
  progress total, `completedAt` the finish time. `expiresAt` is omitted because Buncrawl does not
  expire job results. `skip`/`limit` map to `cursor`/`limit` (pages hold at most 100), and `next`
  is a `/v2` URL with `skip`.
- Cancellation returns `{ success: true, status: "cancelled" }`, or 409 when the job has already
  completed or failed.
- Errors use `{ success: false, code, error, details? }`. `DEADLINE_EXCEEDED` ->
  `SCRAPE_TIMEOUT` (408), `DNS_RESOLUTION_FAILED` -> `SCRAPE_DNS_RESOLUTION_ERROR`,
  `REQUEST_CANCELLED` -> `SCRAPE_JOB_CANCELLED`; other canonical codes and statuses pass through.
  Malformed input (unknown keys or formats, wrong types) returns 400 `BAD_REQUEST`; valid
  Firecrawl options Buncrawl lacks return 400 `UNSUPPORTED_OPTION` listing every one in
  `details`. Other `/v2/*` paths return 404 `UNSUPPORTED_ENDPOINT`.
- Webhooks: a URL string or `{ url, events }`. Firecrawl signs with a team secret rather than a
  per-request one, so the server-wide `BUNCRAWL_WEBHOOK_SECRET` (16+ characters) is used;
  without it a webhook is rejected as unsupported. Events map `started`/`completed` ->
  `state_changed`, `failed` -> `state_changed` + `error`, `page` -> `item_completed` (batch) or
  `page_completed` (crawl). Because `started` and `completed` share `state_changed`, selecting
  either delivers every state change. Deliveries keep Buncrawl's payload and `X-Buncrawl-*`
  signature headers (see 12.8), not Firecrawl's `crawl.page` payloads or
  `X-Firecrawl-Signature`.
- Map waits for its job up to its `timeout` (default 120 s) plus 10 s; past that, or when the
  client disconnects, the job is cancelled and the links found so far are returned with a
  warning. A failed map with no links returns 500.

Unsupported Firecrawl options (rejected with `UNSUPPORTED_OPTION` unless absent, empty, or the
listed default):

- Formats: `json`, `deterministicJson`, `summary`, `changeTracking`, `images`, `rawBase64`,
  `attributes`, `question`, `highlights`, `query`, `product`, `menu`, `audio`, `video`; screenshot
  `quality`; branding `__experimental_screenshot`.
- Scrape options: `actions`, `headers`, `includeTags`, `excludeTags`, `parsers`, `location`,
  `minAge`, `useMock`, `profile`, `threatProtection`, `auditMetadata`, `redactPII` (false),
  `safeMode` (false), `mobile` (false), `onlyCleanContent` (false), `skipTlsVerification`
  (false), `lockdown` (false), `checkPromptInjection` (false), `fastMode` (false), `proxy`
  (`auto` or `basic`), `zeroDataRetention` (false), `domainTools` (false), `toolDetail`, and any
  `__`-prefixed option (false).
- Batch scrape: `appendToId`.
- Crawl and map: `includePaths`, `excludePaths`, `maxDiscoveryDepth` (Buncrawl's `maxDepth`
  counts path segments, not link hops), `allowExternalLinks` (false), `ignoreRobotsTxt` (false),
  `robotsUserAgent`, `sitemap` (`include`), `delay`. Crawl also rejects `prompt`; map also rejects
  `search`, `location`, `headers`, `threatProtection`, `auditMetadata`, and `useMock`.
- Webhooks: `headers`, `metadata`, and any webhook when `BUNCRAWL_WEBHOOK_SECRET` is unset.

Accepted and ignored: `origin`, `integration`, `blockAds`, `removeBase64Images`, branding `mode`,
`maxConcurrency`, `deduplicateSimilarURLs`, `ignoreQueryParameters` (Buncrawl keeps query
strings), `regexOnFullURL`, and map `crawlEntireDomain`, `filterByPath`, `useIndex`,
`ignoreCache`.

Unsupported endpoints include `GET /v2/scrape/:id`, `/v2/search`, `/v2/extract`, `/v2/agent`,
`/v2/parse`, `/v2/crawl/ongoing`, `/v2/crawl/active`, `/v2/crawl/params-preview`, browser,
monitor and team endpoints, and Firecrawl's WebSocket crawl status; use the canonical
`/v1/.../events` SSE streams for live progress.

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
