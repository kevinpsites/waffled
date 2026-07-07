---
title: Authentication & SSO
description: Built-in email/password auth and optional OpenID-Connect single sign-on.
---

Waffled has **email/password authentication built in** — there's nothing to configure to sign
in, and no external identity provider is required. If you'd rather use your own SSO, you can
attach any **OpenID-Connect** provider later, without touching features.

## Built-in auth (the default)

The setup wizard creates the first admin (the household owner). From there, each family member
gets a login on their card in **Settings → Family & people** — see
[Users & members](/administration/users/). That's the whole story for most households:

- **Access tokens** last `ACCESS_TOKEN_TTL_SECONDS` (default 1 h); **refresh tokens** last
  `REFRESH_TOKEN_TTL_DAYS` (default 60). Clients refresh silently.
- Passwords are a minimum of 8 characters. The owner login is protected from removal.
- Locked out? Break-glass from the host: `./waffled admin reset-password` (also `make-admin`,
  `prune-sessions`) — see [Troubleshooting](/operations/troubleshooting/#locked-out--forgot-admin-password).

## Single sign-on (OIDC)

Waffled speaks **OpenID Connect** (authorization-code + PKCE, mediated by the backend) against
any compliant provider — **Authentik, Keycloak, Google, Okta, Entra**, and others. It's
configured **in the app**, stored in your database, not via environment variables.

> **Invite-gated by design.** SSO doesn't auto-create accounts. A person can sign in via SSO
> only if the provider's **verified email** matches an existing family member's login email. So
> you add the person (with their email) first, then they sign in with your IdP.

### Set it up

Configure in **Settings → Login & security** (admin only):

1. **Set `TOKEN_ENCRYPTION_KEY`** in `infra/compose/.env` first — the OIDC **client secret is
   encrypted at rest** with it. (It's auto-generated on first run; just make sure it's present.)
2. Create an **OIDC application** at your provider and note its **Client ID** and **Client
   secret**.
3. In Waffled, enter the **Issuer URL** and click **Test** — this validates the provider's
   discovery document (`.well-known/openid-configuration`).
4. Enter the **Client ID** and **Client secret**.
5. Register the **redirect URI** at your provider:
   `https://your.host/api/auth/oidc/callback` (or `http://localhost:8080/api/auth/oidc/callback`
   locally). For this to be correct behind a hostname, make sure `PUBLIC_BASE_URL` is set — see
   [Reverse proxy & TLS](/install/reverse-proxy/).
6. Toggle **Single sign-on** on and **Save**.

### Force SSO (optional)

Once SSO works, you can **disable password login** to require it. This is guarded so you can't
lock yourself out. If you ever do need the password form back in an SSO-only setup, the
break-glass override is `AUTH_FORCE_PASSWORD=1` in `infra/compose/.env`.

### On iOS

The native app signs in with the same providers — password or SSO. OIDC on iOS uses a system web
auth session and returns to the app via its `waffled://` deep link. Tokens live in the Keychain.

## Auth0 mode (advanced)

For deployments that want to hand *all* token validation to Auth0 (RS256 via JWKS) rather than
Waffled's built-in local auth, set `AUTH0_DOMAIN` (and friends) in the env — this switches the
whole app into Auth0 mode. Most self-hosters never need this; built-in auth plus in-app OIDC
covers SSO. See the Auth0 variables in [Environment variables](/install/environment-variables/#auth0-mode-optional-advanced).

## Troubleshooting

- **"Test" fails on the issuer** — the URL should be the issuer *origin* (Waffled appends
  `.well-known/openid-configuration`). Confirm the provider is reachable from the api container.
- **SSO signs in but says no matching member** — the provider's verified email doesn't match any
  family member's login email. Add/adjust the person's email in
  [Users & members](/administration/users/).
- **Redirect mismatch** — the redirect URI registered at the provider must exactly match
  `PUBLIC_BASE_URL` + `/api/auth/oidc/callback`.
