// Container entrypoint: a tiny HTTP server that adapts Node requests into the
// API Gateway (REST v1) event shape lambda-api expects, then runs the app.
// On AWS this file is unused — lambda.ts is the handler instead.
import http from 'node:http'
import api from './app'
import { config } from './platform/config'
import { startSyncScheduler } from './modules/calendar/calendar-sync'

interface RunResult {
  statusCode: number
  headers?: Record<string, string>
  body?: string
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
      isBase64Encoded: false,
    }
    try {
      const result = (await api.run(event as never, {} as never)) as RunResult
      res.writeHead(result.statusCode, result.headers ?? {})
      res.end(result.body)
    } catch (err) {
      console.error(err)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal', message: (err as Error).message }))
    }
  })
})

server.listen(config.port, () => {
  console.log(`nook-api listening on :${config.port} (auth mode: ${config.auth.mode})`)
  // Background poll: pull Google calendar changes into Nook on an interval so
  // edits/deletes made on the Google side appear without a manual sync.
  startSyncScheduler()
})
