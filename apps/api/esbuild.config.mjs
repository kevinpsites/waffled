// Bundles the TS sources to self-contained CJS for the runtime image / Lambda.
// Deps are bundled in and tree-shaken, so the runtime needs no node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: {
    server: 'src/server.ts', // container HTTP entrypoint
    lambda: 'src/lambda.ts', // AWS Lambda handler
    'mint-token': 'scripts/mint-token.ts', // dev token CLI
    migrate: 'scripts/migrate-cli.ts', // in-container migration runner (compose one-shot)
    otel: 'src/otel.ts', // OTEL preload (NODE_OPTIONS=--require) — see Dockerfile
    'health-cli': 'scripts/health-cli.ts', // `./waffled doctor` runs this in-container
    admin: 'scripts/admin.ts', // `./waffled admin <cmd>` operator/break-glass CLI
    'seed-demo': 'scripts/seed-demo.ts', // `docker compose exec api node dist/seed-demo.js <base|meals|goals>` — demo/screenshot seed
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // lambda-api lazily requires the AWS S3 SDK for an S3 file helper we don't use.
  // Leave it external so it's never bundled (and never loaded at runtime).
  // @opentelemetry/* stays external so the preload's require-time auto-instrumentation
  // works and so the bundled app + preload share one @opentelemetry/api singleton.
  external: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@opentelemetry/*'],
  treeShaking: true,
  minify: true,
  sourcemap: true,
  logLevel: 'info',
})
