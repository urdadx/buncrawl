FROM node:24-slim AS builder
RUN npm install -g pnpm@11
WORKDIR /app

COPY . .
# No .env files are needed: VITE_SERVER_URL comes from the build argument below, and every
# server variable the install-time codegen reads has a default.
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

ARG VITE_SERVER_URL
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
ENV NODE_ENV=production
RUN cd apps/web && pnpm run build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
