# Nook API — TS bundled to JS with esbuild. Multi-stage: build, then a lean runtime.
# esbuild bundles deps into dist/, so the runtime image carries no node_modules.

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

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/dist ./dist
# The .sql migrations ship beside dist/ so `node dist/migrate.js` (the compose
# `migrate` one-shot) can apply the schema with no host tooling. dist/migrate.js
# resolves them at ../migrations relative to itself.
COPY --from=builder /app/migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/server.js"]
