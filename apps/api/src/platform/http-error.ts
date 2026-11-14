// A 4xx a service can throw from any entry point (a route, the capture bar, an MCP tool).
// The app error handler answers it as { error: name, message } with its statusCode, so a
// route that moved its validation into a service keeps the exact same response.
export function httpError(statusCode: number, message: string, name?: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = statusCode
  if (name) err.name = name
  return err
}

export const badRequest = (message: string) => httpError(400, message, 'BadRequest')
