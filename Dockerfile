# Waffled — one image: the api serves the built web SPA, media, and the REST API.
# Build context is the repo root.

# ---- web: build the SPA ----
FROM node:24-alpine AS web
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# ---- api: bundle the server with esbuild ----
FROM node:20-alpine AS api
WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
COPY apps/api/tsconfig.json apps/api/esbuild.config.mjs ./
COPY apps/api/src ./src
COPY apps/api/scripts ./scripts
COPY apps/api/migrations ./migrations
RUN npm run build
# @opentelemetry/* is external to the bundle (see esbuild.config.mjs), so stage just
# those packages and their transitive deps for the runtime image.
RUN mkdir -p /app/otel-deps && cd /app/otel-deps && \
    node -e "const p=require('/app/package.json');const d=Object.fromEntries(Object.entries(p.dependencies).filter(([k])=>k.startsWith('@opentelemetry/')));require('fs').writeFileSync('package.json',JSON.stringify({name:'otel-deps',version:'1.0.0',dependencies:d}))" && \
    npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ARG GIT_SHA=dev
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME \
    NODE_ENV=production \
    PORT=3000 \
    WEB_ROOT=/app/web \
    DATA_DIR=/data \
    MEDIA_DIR=/data/media \
    UPDATE_CHECK_REPO=evan-ribbey/waffled-ng
# The preload only starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set.
COPY --from=api /app/otel-deps/node_modules ./node_modules
ENV NODE_OPTIONS=--require=/app/dist/otel.js
COPY --from=api /app/dist ./dist
# dist/start.js applies these on boot; it resolves them at ../migrations.
COPY --from=api /app/migrations ./migrations
COPY --from=web /app/dist ./web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data/media && chown -R node:node /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
# Starts as root only so the entrypoint can fix volume ownership, then drops to node.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/start.js"]
