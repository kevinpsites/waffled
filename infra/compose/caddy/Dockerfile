# Build the web SPA and bake it into the Caddy image that serves it, so
# `docker compose up --build` is fully reproducible with no host build step.
# Build context is the repo root (see docker-compose.yml).

FROM node:24-alpine AS web
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm ci || npm install
COPY apps/web/ ./
RUN npm run build

FROM caddy:2
COPY --from=web /app/dist /srv
# Ship the config too, so the image serves Waffled on its own. Compose still mounts this
# same file over it (identical content) until every supported install runs an image that
# carries it; the repo copy stays canonical — the native Mac bundle copies it verbatim.
COPY infra/compose/caddy/Caddyfile /etc/caddy/Caddyfile
