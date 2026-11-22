# Buncrawl

Buncrawl is a web data API for AI agents, built with native Bun APIs.

## Tech Stack

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **tRPC** - End-to-end type-safe APIs
- **Bun** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **SQLite** - Database engine
- **Oxlint** - Oxlint + Oxfmt (linting & formatting)

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

## Database Setup

This project uses SQLite with Drizzle ORM.

1. Start the local SQLite database (optional):

```bash
pnpm run db:local
```

2. Update your `.env` file in the `apps/server` directory with the appropriate connection details if needed.

   Local development defaults to `.data/buncrawl.db` and `.data/artifacts` in the repository root. Docker Compose overrides these with persistent `/data` paths inside the container.

3. Apply the schema to your database:

```bash
pnpm run db:push
```

Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## Deployment

### Install the binary

Linux and macOS (x64 and arm64), from the latest GitHub release; the script checks the download
against the release's `SHA256SUMS`:

```bash
curl -fsSL https://raw.githubusercontent.com/urdadx/buncrawl/main/install.sh | sh
```

```bash
buncrawl https://example.com
```

`BUNCRAWL_VERSION=v1.2.3` installs a specific release and `BUNCRAWL_INSTALL_DIR` picks the folder
(default `/usr/local/bin` when writable, else `~/.local/bin`; it never uses sudo). Pushing a `v*`
tag builds the release (`.github/workflows/release.yml`, `apps/server/scripts/build-release.sh`)
and publishes the image as `ghcr.io/urdadx/buncrawl`.

### Docker

The server image runs with no configuration; the volume keeps its SQLite database and artifacts:

```bash
docker run -d -p 3000:3000 -v buncrawl:/data -e BUNCRAWL_API_KEY=change-me-to-16-plus-chars ghcr.io/urdadx/buncrawl:latest
```

To build it yourself instead: `docker build -f apps/server/Dockerfile -t buncrawl-server .`

Every variable in `apps/server/.env.schema` can be passed with `-e`. `GET /v1/capabilities` shows
which browsers the image found.

### Docker Compose

- Target: web + server
- Config: `docker-compose.yml` (app Dockerfiles live in `apps/*/Dockerfile`)
- Build images: pnpm run docker:build
- Start: pnpm run docker:up
- Logs: pnpm run docker:logs
- Stop: pnpm run docker:down

Set `BUNCRAWL_API_KEY` (at least 16 characters, e.g. `openssl rand -hex 24`) in `apps/server/.env`
before exposing the server: clients then send `Authorization: Bearer <key>`, as Firecrawl SDKs
do. Several keys can be listed, separated by commas, to rotate them. Without it the API is open to
anyone who can reach it, and the server logs a warning at startup. `GET /` (health) and the
dashboard's `/trpc` health query stay public.

Environment variables are read from each app's `.env` file (baked into web builds for public variables) and overridden in `docker-compose.yml` for container networking.

Docker Compose persists SQLite at `./.data/buncrawl.db` and artifacts under
`./.data/artifacts`. The server applies its required storage schema during startup.

### Single-file binary

`pnpm --filter server compile` builds `apps/server/server`, one executable with the Bun runtime,
the server, and its browser and extraction workers. It needs no `node_modules`, `.env`, or
`.env.schema` beside it: configure it with plain environment variables.

```bash
pnpm --filter server compile
```

```bash
BUNCRAWL_API_KEY=change-me-to-16-plus-chars ./apps/server/server
```

- Nothing is required. Data goes to a `data` folder in the working directory unless
  `DATABASE_URL` (a `file:` path or a libSQL URL) and `BUNCRAWL_ARTIFACTS_PATH` say otherwise;
  `CORS_ORIGIN` defaults to `*`; `PORT` to 3000. An invalid variable stops startup with its name.
- Redis is optional (`REDIS_URL`): it only wakes job workers in other server processes sooner;
  workers poll the database without it.
- Recommended: `BUNCRAWL_API_KEY`, the Bearer key clients must send (see Docker Compose above).
- Optional: every other variable in `apps/server/.env.schema` (R2, `BUNCRAWL_PROXY_URL`,
  `BUNCRAWL_WEBHOOK_SECRET`, and the browser settings below).
- Browser rendering uses the host's browsers: Lightpanda from `BUNCRAWL_LIGHTPANDA_PATH` or
  `lightpanda` on `PATH`, and Chrome or Chromium from `BUN_CHROME_PATH` or `PATH`. Set
  `BUNCRAWL_CHROME_NO_SANDBOX=1` where Chrome's sandbox cannot start. `GET /v1/capabilities`
  reports what the startup check found; without browsers the binary still scrapes over HTTP.
- The binary targets the OS and CPU it was built on; cross-compile with Bun's `--target`.
- Unlike the varlock setup used by `pnpm run dev` and the Docker image, the binary does not
  redact secrets from its console output.

#### Command line

The same binary scrapes a single page without a server, database or configuration:

```bash
./apps/server/server https://example.com
```

```bash
./apps/server/server scrape https://example.com --render --format html --screenshot page.png
```

- `buncrawl <url>` is short for `buncrawl scrape <url>`; with no arguments, or `serve`, it starts
  the API server.
- One text format (`--format markdown|html|rawHtml|links`, Markdown by default) prints as-is on
  stdout; several formats, or `--json`, print the API response as JSON. Failures print
  `buncrawl: CODE: message` on stderr and exit 1; usage errors exit 2.
- `--render` forces a browser and `--no-render` never starts one; by default the page decides,
  as with `renderJs: "auto"`. Renders use local Chrome or Lightpanda found the same way as the
  server. `buncrawl --help` lists every option.

Map, crawl and batch scrape run the API's jobs in-process, with the same handlers and workers
as the server, over a private in-memory database:

```bash
buncrawl map https://example.com --limit 500
```

```bash
buncrawl crawl https://example.com --limit 50 --depth 2 --out pages
```

```bash
buncrawl batch urls.txt --format html > pages.jsonl
```

- `map` prints one URL per line (`--json` for an array). `crawl` and `batch` print JSON Lines,
  one item per page as `GET /v1/crawl/:id` returns it; `crawl --out <dir>` (and `batch --out`)
  instead writes one Markdown file per page, plus a PNG per page with `--screenshots`.
- Limits mirror the API: `--limit` (default 100), `--depth` (default 10) and `--timeout` for the
  whole job (default 120000 ms); `--subdomains` and `--path-prefix` widen or narrow the scope.
- Progress goes to stderr. The first Ctrl-C cancels the job and still prints the pages that
  finished (exit 130); a second one quits at once. `--db <file>` keeps the job in a SQLite file
  instead of memory for very large crawls.

## Project Structure

```
buncrawl/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
│   └── server/      # Backend API (Bun, TRPC)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:generate`: Generate database client/types
- `pnpm run db:migrate`: Run database migrations
- `pnpm run docker:build`: Build the Docker Compose images
- `pnpm run docker:up`: Build and start the Docker Compose stack
