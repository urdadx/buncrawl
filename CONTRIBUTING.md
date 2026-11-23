# Contributing

## Setup

You need [Bun](https://bun.sh) and [pnpm](https://pnpm.io).

```bash
pnpm install
```

```bash
pnpm run dev
```

The API runs at http://localhost:3000. Chrome or Lightpanda is optional; without one, pages are
scraped over plain HTTP.

## Layout

- `apps/server`: the API server and CLI
- `apps/web`: the dashboard
- `apps/docs`: the docs site (`pnpm --filter docs dev`)
- `packages/*`: shared libraries (scrape, crawl, jobs, renderer and more)

## Before you open a pull request

Run the tests in each package you changed:

```bash
cd apps/server && bun test
```

Check types, lint and format:

```bash
pnpm run check-types
```

```bash
pnpm run check
```

If you changed a route or contract, regenerate the OpenAPI spec:

```bash
pnpm --filter server openapi
```

If you changed behaviour, update the docs in `apps/docs/docs`.

## Pull requests

- Keep each pull request to one change.
- Write the commit title as a short sentence that says what changed.
- Open an issue first for large changes.

By contributing, you agree that your work is licensed under the [MIT License](LICENSE).
