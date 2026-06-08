// The shared lambda-api app: one routes file, two entrypoints (server.ts, lambda.ts).
import createAPI, { type Request, type Response, type NextFunction } from 'lambda-api'
import { config } from './config'
import { requireAuth } from './auth'

const api = createAPI()

// Routes that skip auth.
const PUBLIC_PATHS = new Set(['/healthz'])

// Auth gate — runs before every route except the public ones.
api.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) return next()
  await requireAuth(req) // throws AuthError → error handler below
  next()
})

// --- routes ---

// Liveness. Also reports which auth strategy is active, handy during the swap.
api.get('/healthz', async () => ({
  ok: true,
  service: 'nook-api',
  authMode: config.auth.mode,
}))

// Echoes the authenticated tenant context — the fastest proof the JWT flow works.
api.get('/api/me', async (req: Request) => ({
  sub: req.tenant?.sub,
  householdId: req.tenant?.householdId,
}))

// Error handler — lambda-api treats a 4-arg middleware as the error sink.
api.use(
  (err: Error & { statusCode?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode ?? 500
    if (status >= 500) console.error(err)
    res.status(status).json({ error: err.name || 'Error', message: err.message })
  }
)

export default api
