# Nook API — TS bundled to JS with esbuild. Multi-stage: build, then a lean runtime.
# esbuild bundles deps into dist/, so the runtime carries no node_modules EXCEPT the
# OpenTelemetry packages (kept external on purpose — see esbuild.config.mjs).

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json esbuild.config.mjs ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build
# Stage ONLY the @opentelemetry/* deps (+ their transitive deps) in an isolated
# node_modules so the runtime image gets them and nothing else. Versions come from
# the app's package.json.
RUN mkdir -p /app/otel-deps && cd /app/otel-deps && \
    node -e "const p=require('/app/package.json');const d=Object.fromEntries(Object.entries(p.dependencies).filter(([k])=>k.startsWith('@opentelemetry/')));require('fs').writeFileSync('package.json',JSON.stringify({name:'otel-deps',version:'1.0.0',dependencies:d}))" && \
    npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Build provenance — surfaced on /healthz + /api/health (passed by ./nook / CI).
ARG GIT_SHA=dev
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
# OpenTelemetry packages, loaded ONLY by the --require preload below and only when
# OTEL_EXPORTER_OTLP_ENDPOINT is set. The bundled app reaches the same
# @opentelemetry/api singleton from this node_modules.
COPY --from=builder /app/otel-deps/node_modules ./node_modules
ENV NODE_OPTIONS=--require=/app/dist/otel.js
COPY --from=builder /app/dist ./dist
# The .sql migrations ship beside dist/ so `node dist/migrate.js` (the compose
# `migrate` one-shot) can apply the schema with no host tooling. dist/migrate.js
# resolves them at ../migrations relative to itself.
COPY --from=builder /app/migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/server.js"]
