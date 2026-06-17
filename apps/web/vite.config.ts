/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies /api to the local api container so the SPA and api share an
// origin (no CORS), exactly like Caddy does in the compose stack.
export default defineConfig({
  plugins: [react()],
  // @powersync/web ships its own SQLite WASM + worker; pre-bundling breaks them,
  // so exclude it from Vite's dep optimizer (PowerSync's documented Vite setup).
  optimizeDeps: { exclude: ['@powersync/web'] },
  worker: { format: 'es' },
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  // `vite preview` mirrors the dev proxy so a production build can be exercised
  // against the local api (and the service worker's /api caching verified).
  preview: {
    port: 4173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
