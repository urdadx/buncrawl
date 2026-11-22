# syntax=docker/dockerfile:1.7

# Pinned runtime and browser builds. Bump a version together with its checksum; the browser smoke
# tests (packages/renderer/test/browser-smoke.test.ts) run in the `smoke` target, which is this
# image plus the renderer sources, in CI.
ARG BUN_VERSION=1.4.2
ARG CHROME_VERSION=158.0.8127.36
ARG CHROME_SHA256=2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a
ARG LIGHTPANDA_VERSION=1.0.5
ARG LIGHTPANDA_SHA256=0ec21fa4867ab9e82b35285ff4ab0e7336c6c1d89f26fe991f27d73c8a678bd7

FROM oven/bun:${BUN_VERSION}-slim AS bun

# Compiles the server into one executable (`pnpm --filter server compile`); the image ships that
# file instead of the workspace and its node_modules.
FROM node:24-slim AS builder
RUN npm install -g pnpm@11.23.0
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Downloads every locked package into a store inside this layer, so source changes reuse it (also
# from a registry cache such as type=gha, which does not keep cache mounts) and only re-link below.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod --store-dir /pnpm-store

COPY . .
# Only the server and the workspace packages it imports, without dev dependencies. No install
# scripts: compiling needs neither varlock's generated env types nor any native build step.
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter "server..." --store-dir /pnpm-store
RUN cd apps/server && bun run compile

# Downloads and verifies the browsers. Chrome for Testing publishes x86-64 Linux builds only, so the
# image is linux/amd64.
FROM debian:trixie-slim AS browsers
ARG TARGETARCH
ARG CHROME_VERSION
ARG CHROME_SHA256
ARG LIGHTPANDA_VERSION
ARG LIGHTPANDA_SHA256
RUN test "${TARGETARCH:-amd64}" = "amd64" || { echo "Only linux/amd64 is supported: Chrome for Testing has no ${TARGETARCH} build" >&2; exit 1; }
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
  && echo "${CHROME_SHA256}  /tmp/chrome.zip" | sha256sum -c - \
  && unzip -q /tmp/chrome.zip -d /tmp \
  && mv /tmp/chrome-headless-shell-linux64 /opt/chrome \
  && rm /tmp/chrome.zip
RUN mkdir -p /opt/lightpanda \
  && curl -fsSLo /opt/lightpanda/lightpanda "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux" \
  && echo "${LIGHTPANDA_SHA256}  /opt/lightpanda/lightpanda" | sha256sum -c - \
  && chmod 0755 /opt/lightpanda/lightpanda

FROM bun AS runtime
# Shared libraries headless Chrome loads, plus fonts so pages and screenshots render real text:
# Liberation is metric-compatible with Arial/Times/Courier, Noto covers CJK and emoji.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libudev1 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=browsers /opt/chrome /opt/chrome
COPY --from=browsers /opt/lightpanda /opt/lightpanda
# Docker's default seccomp profile denies the user namespaces Chrome's sandbox needs, so Chrome runs
# with --no-sandbox. Each page still runs as an unprivileged user in a dedicated worker process,
# behind the CDP request guard and the DNS-pinning safety proxy. Set BUNCRAWL_CHROME_NO_SANDBOX=0
# where the container may create user namespaces (e.g. a seccomp profile that allows them).
ENV BUN_CHROME_PATH=/opt/chrome/chrome-headless-shell \
  BUNCRAWL_LIGHTPANDA_PATH=/opt/lightpanda/lightpanda \
  BUNCRAWL_CHROME_NO_SANDBOX=1

# Fail the build, not the first render, when a browser is missing a library or cannot start.
RUN missing="$(ldd "$BUN_CHROME_PATH" "$BUNCRAWL_LIGHTPANDA_PATH" | grep 'not found' || true)"; \
  if [ -n "$missing" ]; then echo "Missing browser libraries:\n$missing" >&2; exit 1; fi; \
  "$BUN_CHROME_PATH" --version && "$BUNCRAWL_LIGHTPANDA_PATH" version

# `docker run -v buncrawl:/data` keeps the database and artifacts; the entrypoint makes /data
# writable for the `bun` user.
ENV NODE_ENV=production \
  DATABASE_URL=file:/data/buncrawl.db \
  BUNCRAWL_ARTIFACTS_PATH=/data/artifacts
# The compiled server: Bun runtime, server, and browser and extraction workers in one read-only file.
COPY --from=builder /app/apps/server/server /app/server

# The entrypoint starts as root only to make /data writable, then runs everything as `bun`:
# the browsers never run as root.
COPY --chmod=0755 apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/server"]

# CI only: the runtime image plus the renderer sources and their production dependencies, so the
# browser smoke tests run against exactly the runtime image's browsers, libraries and fonts.
FROM runtime AS smoke
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages /app/packages

# The default target, and the image to deploy.
FROM runtime AS runner
