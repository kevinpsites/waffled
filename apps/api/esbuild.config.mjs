// Bundles the TS sources to self-contained CJS for the runtime image / Lambda.
// Deps are bundled in and tree-shaken, so the runtime needs no node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: {
    server: 'src/server.ts', // container HTTP entrypoint
    start: 'src/start.ts', // single-image entrypoint: secrets bootstrap -> migrate -> server
    lambda: 'src/lambda.ts', // AWS Lambda handler
    'mint-token': 'scripts/mint-token.ts', // dev token CLI
    migrate: 'scripts/bin/migrate.ts', // in-container migration runner
    otel: 'src/otel.ts', // OTEL preload (NODE_OPTIONS=--require) — see Dockerfile
    'health-cli': 'scripts/bin/health-cli.ts', // run in-container via docker compose exec
    admin: 'scripts/bin/admin.ts', // operator/break-glass CLI
    'seed-demo': 'scripts/bin/seed-demo.ts', // demo/screenshot seed; scripts/bin/* load /data/secrets.json first
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
