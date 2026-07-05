# Security Policy

Thanks for helping keep Waffled and its users safe. Waffled is a small, self-hosted
family hub, maintained on a best-effort basis — we take security seriously and
appreciate responsible disclosure.

## Reporting a vulnerability

**Please report vulnerabilities privately. Do not open a public issue for a
security problem.**

Preferred channel: **GitHub private vulnerability reporting**. Go to the
repository's **Security → Advisories → "Report a vulnerability"** and open a
draft advisory. This keeps the report private, gives us a place to collaborate on
a fix, and requires no shared inbox.

If you can't use GitHub advisories, email the maintainer at
`security@<your-domain>` *(maintainers: replace with your address)*.

### What to include

- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept, affected endpoint/route, request/config).
- The version / commit you tested against and your deployment setup.
- Any suggested remediation, if you have one.

### What to report

- Auth / session / token handling flaws (API auth guards, kiosk pairing, OIDC,
  PowerSync JWTs).
- Injection, SSRF, path traversal, or data-exposure bugs in `apps/api`.
- XSS or client-side auth issues in `apps/web`.
- Insecure defaults in `infra/compose` (docker compose, Caddy, generated
  secrets) that affect a default install.

## What NOT to do

- **Do not open a public GitHub issue or PR that describes the vulnerability.**
- **Do not run automated scanners, brute-force, or exploit tooling against
  instances you don't own.** Waffled is self-hosted — every instance belongs to a
  family. Test only against your own local deployment.
- Don't access, modify, or exfiltrate data that isn't yours.

## Response expectations

This is a small, volunteer-maintained project, so responses are **best-effort**.
We aim to acknowledge a report within a few days and to keep you updated as we
investigate. We'll credit reporters in the advisory unless you prefer to remain
anonymous.

## Supported versions

Waffled is **pre-1.0**. There is **no LTS release**. Security fixes land on the
**latest release and `main`**; there is no back-porting to older tags. Operators
should track the latest release and keep their images up to date.

## Operator responsibility (self-hosted)

Waffled is self-hosted, so **you** — the operator — are responsible for the security
of your deployment. At minimum:

- **Serve over HTTPS.** The bundled Caddy config terminates TLS; don't expose the
  API/web over plain HTTP on an untrusted network.
- **Manage your secrets.** `./waffled up` generates secrets into
  `infra/compose/.env` on first run. Keep that file private, back it up, and
  never commit it. Some secrets (e.g. an OIDC client secret) are unrecoverable if
  lost.
- **Keep images updated.** Pull and redeploy new releases promptly to pick up
  security fixes.
- **Limit exposure.** Restrict network access to trusted devices/users where
  possible.

Vulnerabilities that require an operator to have disabled these protections
(e.g. running plaintext HTTP, leaking `.env`) are generally out of scope.
