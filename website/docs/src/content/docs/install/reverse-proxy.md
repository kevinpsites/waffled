---
title: Reverse proxy & TLS
description: Access Waffled from other devices, behind a hostname, with HTTPS.
---

Waffled is a shared hub: a kitchen tablet, phones, other computers. The app serves plain HTTP
on one port (`8080` by default) and does everything itself (web app, API, media), so there is
nothing to wire together. You only need a reverse proxy if you want a hostname or HTTPS.

## LAN access (most common)

For a tablet or phone on your home network, no configuration is needed:

1. Find the host's LAN IP (say `192.168.1.20`).
2. On the device, open `http://192.168.1.20:8080`.

> **Reserve a static IP** for the host in your router (DHCP reservation) so bookmarks and the
> kiosk tablet keep working.

Plain HTTP is fine on a home network. The **barcode camera scanner** in the web app needs a
*secure context* (HTTPS or `localhost`), so on a plain `http://LAN-IP` origin the browser
blocks the camera and you type barcodes instead. Use a hostname with HTTPS (below) if you want
camera scanning on a tablet.

## A hostname with HTTPS

Put any reverse proxy you control (Caddy, nginx, Traefik, a Cloudflare Tunnel, Tailscale
serve) in front of the app, terminate TLS there, and proxy everything to `localhost:8080`
(or the host's address). For example, with Caddy:

```text
waffled.example.com {
    reverse_proxy localhost:8080
}
```

Then add two settings to `.env` beside `compose.yaml` and run `docker compose up -d`:

```bash
PUBLIC_BASE_URL=https://waffled.example.com
TRUST_PROXY=true
```

| Variable | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | The public origin used for OAuth/OIDC redirect URLs (Google and Outlook calendar connect, SSO sign-in). Set it whenever you reach Waffled through a hostname. |
| `TRUST_PROXY` | Honour `X-Forwarded-For`, `-Proto` and `-Host`. Off by default. |

### Only turn on `TRUST_PROXY` behind a proxy you control

With `TRUST_PROXY` off, Waffled uses the connection's own address and the request's own
protocol and host. With it on, it believes whatever the forwarded headers say, so a client that
can reach port 8080 **directly** could spoof its address past the rate limiter. If you enable
it, make sure only your proxy can reach the app: set `HTTP_PORT=127.0.0.1:8080` in `.env` to
publish the port on localhost only (no compose override needed), or use a firewall.
Leave it unset when you expose the port straight to your LAN.

## Redirect URLs for sign-in and calendars

Register redirect URIs at the provider using your public origin, for example
`https://waffled.example.com/api/auth/oidc/callback` for SSO and
`https://waffled.example.com/auth/google/calendar/callback` (or
`/auth/microsoft/calendar/callback`) for calendars. Set `GOOGLE_CALENDAR_REDIRECT_URI` /
`MS_CALENDAR_REDIRECT_URI` to the same values. See [Environment variables](/install/environment-variables/).
