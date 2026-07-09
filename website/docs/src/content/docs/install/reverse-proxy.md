---
title: Reverse proxy & TLS
description: Access Waffled from other devices, behind a hostname, with HTTPS.
---

Waffled's whole point is a shared hub — a kitchen tablet, the iOS app, other computers. That
means the sync endpoint has to be reachable at an address those devices can actually use.
Getting this right is the difference between "everything syncs" and "everything shows Offline."

## The built-in proxy: Caddy

Waffled ships **Caddy** as its reverse proxy *and* web server. You don't add your own proxy
unless you want to — Caddy already:

- Serves the web/kiosk SPA (baked into the image).
- Proxies `/api/*` → the api container.
- Serves uploaded media at `/media/*`.
- Can provision **automatic HTTPS** for a real hostname.

## The easy path: `./waffled setup`

Run `./waffled setup` and answer one question — "how will devices reach this server?" — and it
writes the right address variables for you:

| Choice | What it sets | Use when |
|---|---|---|
| **Just this computer** | localhost defaults | You only use Waffled on the host itself. |
| **Other devices on my network** | `POWERSYNC_PUBLIC_URL` + `PUBLIC_BASE_URL` → this machine's **LAN IP** | A tablet / phone / laptop on your home network (the common case). |
| **A hostname with automatic HTTPS** | `CADDY_SITE_ADDRESS` (auto-TLS) + `PUBLIC_BASE_URL` | You have a domain pointing at the machine. |

Run it **before** `./waffled up` for the simplest flow, or any time later — then run `./waffled
up` again to apply it (a bare `./waffled restart` reuses the old values).

> **The #1 gotcha:** the tablet shows "Offline" because `POWERSYNC_PUBLIC_URL` is still
> `localhost`, which the tablet can't reach. `setup` fixes this by using your LAN IP. See
> [Troubleshooting](/operations/troubleshooting/#powersync-offline-banner).

## LAN access (most common)

For a tablet or phone on your home network:

1. `./waffled setup` → **Other devices on my network**. It detects the machine's IP (say
   `192.168.1.20`) and sets `POWERSYNC_PUBLIC_URL=http://192.168.1.20:8090` and
   `PUBLIC_BASE_URL=http://192.168.1.20:8080`.
2. `./waffled up`.
3. On the device, open `http://192.168.1.20:8080`.

> **Reserve a static IP** for the host in your router (DHCP reservation), so the address doesn't
> drift and break sync later.

Local LAN access is **plain HTTP** — that's fine for a home network. Note that the **barcode
camera scanner** in the web app needs a *secure context* (HTTPS or `localhost`), so on a plain
`http://LAN-IP` origin the browser blocks the camera and you type barcodes instead. If you want
camera scanning on a tablet, use the hostname + HTTPS setup below (the native iOS app has no such
restriction).

## Hostname with automatic HTTPS

If you have a domain (or a local hostname via something like `.local` / an internal DNS entry)
pointing at the machine:

1. `./waffled setup` → **A hostname with automatic HTTPS**, which sets `CADDY_SITE_ADDRESS` to
   your hostname. A hostname (not `:80`) tells Caddy to provision a real certificate via ACME
   (Let's Encrypt) and store it in the `caddy_data` volume.
2. **Enable the `443` port mapping** in `infra/compose/docker-compose.yml` (it's commented out by
   default) so Caddy can serve HTTPS.
3. Point DNS at the machine and make sure port `443` is reachable.
4. `./waffled up`.

For **remote sync over HTTPS**, PowerSync serves on its own port (`8090`) — expose and proxy it
with TLS too, and set `POWERSYNC_PUBLIC_URL` to that HTTPS address.

## Behind your own reverse proxy

Prefer to terminate TLS at an existing Traefik / nginx / Caddy you already run? You can — just
proxy two upstreams and set the public URLs to match:

- **Web + api:** proxy your hostname to the Caddy container's HTTP port (`8080`). Caddy handles
  `/api/*` and `/media/*` internally, so a single upstream covers the app.
- **PowerSync:** proxy a second hostname/path to the PowerSync port (`8090`), and set
  `POWERSYNC_PUBLIC_URL` to that public address.

Then set `CADDY_SITE_ADDRESS=:80` (let your outer proxy own TLS) and `PUBLIC_BASE_URL` to your
public origin.

## Editing by hand

The three variables `setup` writes are just entries in `infra/compose/.env` — you can set them
directly and `./waffled up`:

| Variable | Meaning |
|---|---|
| `POWERSYNC_PUBLIC_URL` | The sync endpoint clients connect to — **the common trap**; must be device-reachable. |
| `PUBLIC_BASE_URL` | Public origin used for calendar / OIDC redirect URLs. |
| `CADDY_SITE_ADDRESS` | `:80` for plain HTTP, or a hostname to turn on Caddy auto-TLS. |

See the full list in [Environment variables](/install/environment-variables/).
