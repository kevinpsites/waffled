// Where to land after an OIDC sign-in. The api only returns to this origin's root (its
// redirect allowlist strips the path), so the page that started sign-in — e.g. an
// /oauth/authorize consent link with its whole query — is kept here across the round trip.
const KEY = 'waffled.returnTo'

function samePath(p: string | null): p is string {
  return !!p && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') && !p.startsWith('/auth/callback')
}

export function rememberReturnPath(): void {
  const here = window.location.pathname + window.location.search
  try {
    if (here !== '/' && samePath(here)) sessionStorage.setItem(KEY, here)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: land on the root, as before */
  }
}

// The remembered path, once. Anything that is not a same-origin path is dropped.
export function takeReturnPath(): string {
  try {
    const p = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return samePath(p) ? p : '/'
  } catch {
    return '/'
  }
}
