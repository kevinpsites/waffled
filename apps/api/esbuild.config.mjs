// Bundles the TS sources to self-contained CJS for the runtime image / Lambda.
// Deps are bundled in and tree-shaken, so the runtime needs no node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: {
    server: 'src/server.ts', // container HTTP entrypoint
    lambda: 'src/lambda.ts', // AWS Lambda handler
    'mint-token': 'scripts/mint-token.ts', // dev token CLI
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // lambda-api lazily requires the AWS S3 SDK for an S3 file helper we don't use.
  // Leave it external so it's never bundled (and never loaded at runtime).
  external: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
  treeShaking: true,
  minify: true,
  sourcemap: true,
  logLevel: 'info',
})
