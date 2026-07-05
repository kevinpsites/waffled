// Build/version info surfaced on /healthz and /api/health so an operator can see
// exactly which build is running. GIT_SHA + BUILD_TIME are baked into the image at
// docker build (Dockerfile ARG → ENV; the ./waffled CLI passes them). They fall back
// to 'dev'/null for a from-source/local run.
import pkg from '../../package.json'

export interface VersionInfo {
  pkg: string
  sha: string
  buildTime: string | null
}

export const version: VersionInfo = {
  pkg: (pkg as { version?: string }).version ?? '0.0.0',
  sha: process.env.GIT_SHA || 'dev',
  buildTime: process.env.BUILD_TIME || null,
}
