# Buncrawl

Give your AI agent structured internet data in Markdown, HTML, JSON and more.

**[Documentation](https://buncrawl.urdadx.com)**

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/urdadx/buncrawl/main/install.sh | sh
```

## Usage

```bash
buncrawl example.com
```

```bash
buncrawl map example.com
```

```bash
buncrawl crawl example.com --limit 50 --out pages
```

```bash
buncrawl batch urls.txt
```

## Run the API server

```bash
docker run -p 3000:3000 ghcr.io/urdadx/buncrawl:latest
```

```bash
curl localhost:3000/v1/scrape \
  -H "content-type: application/json" \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

See [Self-hosting](https://buncrawl.urdadx.com/self-hosting) to add an API key, keep data in a volume or run the binary without Docker.

## Develop

```bash
pnpm install
```

```bash
pnpm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
