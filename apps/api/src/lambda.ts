// AWS Lambda entrypoint. Unused locally (server.ts handles the container path),
// kept in lockstep so the same routes deploy to Lambda without changes.
import type { APIGatewayProxyEvent, Context } from 'aws-lambda'
import api from './app'

export const handler = (event: APIGatewayProxyEvent, context: Context) =>
  api.run(event as never, context as never)
