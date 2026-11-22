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
PORT=3000 CORS_ORIGIN=http://localhost:3001 DATABASE_URL=file:/var/lib/buncrawl/buncrawl.db BUNCRAWL_ARTIFACTS_PATH=/var/lib/buncrawl/artifacts ./apps/server/server
```

- Required: `CORS_ORIGIN`, `DATABASE_URL` (a `file:` path or a libSQL URL), and
  `BUNCRAWL_ARTIFACTS_PATH`. The binary does not fall back to the development paths in
  `apps/server/.env.schema`; it exits and names any missing or invalid variable.
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
