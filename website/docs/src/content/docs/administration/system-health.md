---
title: System health
description: Check that Waffled is healthy — doctor, the health panel, and metrics.
---

Waffled ships a **deep health report** covering **db, migrations, jobs, calendar,
storage, and backup**. This page is how you read it, plus the optional metrics stack.
For symptom → fix, see [Troubleshooting](/operations/troubleshooting/).

## Four ways to see health

| Method | Depth | Who | Notes |
|---|---|---|---|
| `./waffled doctor` | deep, in-container | host | **Exits non-zero when anything is degraded/down** — good for cron/monitoring |
| **Settings → System Health** | deep | admin | Same report, in the UI |
| `GET /api/health` | deep, per-component JSON | admin | Machine-readable full report |
| `GET /healthz` | shallow | public | DB ping + version/build info; backs the container healthcheck |

`./waffled doctor` is the one to reach for first — because it **exits non-zero** when
anything is unhealthy, it drops straight into a cron job or an uptime monitor.

## Reading the report

### Backup line

The **backup** line turns **degraded** if the **last backup failed**, or the **newest
success is older than ~48 h** (two missed daily cycles). Fix it via
[Backup & restore](/operations/backup/).

### Migrations line

The **migrations** line flags **"schema behind"** when **applied < available**. Bring
the schema forward:

```bash
./waffled migrate
```

### Live Sync (this browser)

Every other card on this panel describes the **server**. The **Live Sync** card describes
**the browser you are looking at** — whether *this* device's offline copy of the calendar
is actually being kept up to date. Two people can be on the same healthy server and see
different Live Sync states.

| State | What it means | What to do |
|---|---|---|
| **starting…** | The sync engine is booting. It loads a small database engine into the browser, which takes a few seconds on a cold tab. | Nothing — wait. |
| **live** | Connected and fully synced. The calendar reads from the local copy, so it's instant and works offline. | Nothing. |
| **connecting…** | Between connections, or the first full sync hasn't finished. Normal after a reload or a network blip. | Nothing, unless it persists. |
| **offline** | This device has no network. Sync is paused on purpose and no stall is counted. | Reconnect. |
| **waiting for sign-in** | No credentials yet, so there is nothing to sync. | Sign in. |
| **stalled — auto-restarting** | Online and signed in, but the engine hasn't reached a synced state for 3 minutes. The watchdog is already restarting it. | Usually nothing — see below. |
| **failed to start** | The engine crashed on boot; the card shows the actual error. Common causes are a browser with storage disabled, private-browsing mode, another tab holding the local database, or a very old browser. The watchdog keeps retrying the rebuild on the same backoff, so the transient causes clear by themselves. | Read the error. If it persists, try a normal browser window, or **Reset local copy**. |
| **off** | The engine isn't running at all in this browser. | Reload the page. |

**Your data is safe in every one of these states.** When the local copy can't be trusted —
stalled, still starting, failed, or never fully synced — the calendar reads straight from
the server instead. A stuck sync engine can slow live updates down; it can't show you a
blank calendar.

#### What the watchdog does on a stall

Waffled tries to fix a stall by itself, escalating one rung at a time and backing off
between attempts (2 minutes, then 4, 8, and 16 as a ceiling) so a server that's genuinely
down heals on its own without being hammered:

1. **Reconnect** — drop and re-dial the sync connection.
2. **Rebuild** — throw the sync engine away and build a fresh one.
3. **Reset the local copy** — wipe this browser's copy and re-download everything. This is
   **skipped automatically whenever unsent changes might still be queued** — both when the
   queue is known to hold work and when a wedged engine can't be asked — so the watchdog
   can never destroy a change that hasn't reached the server.

Rung 3 is **tried at most once**, then the watchdog falls back to repeating rung 2. If
wiping the local copy didn't help, the local copy was never the problem, and a server
that stays down for hours must not cost you your offline copy over and over. (A fully
successful sync re-arms it, so a later, unrelated problem can reach for it again.) When
the engine crashes on boot rather than stalling, the watchdog only retries rung 2 — a
crash is no evidence the local copy is at fault.

A **⟳ Live sync is reconnecting** strip appears across the top of the app while this is
happening — it's there to explain why live updates may lag, not to warn you about your
data.

The card also shows a **watchdog restarts** count for the current tab. A handful over a
long session is unremarkable; a number that keeps climbing points at the PowerSync service
rather than the browser — check the `waffled-powersync` container and see
[Troubleshooting](/operations/troubleshooting/).

#### Doing it by hand

**⟳ Restart sync** rebuilds the engine immediately (rung 2) — the first thing to try if a
device seems stuck. **🧹 Reset local copy** appears while sync is stalled or the engine
failed to start, and does rung 3: it wipes this browser's local copy and re-downloads it
from the server. Nothing you have saved is lost, and unsent changes still block the wipe.
The two buttons never get crossed: asking for one while the other is already running runs
yours too, rather than quietly giving you the other one's result.

## Update notifier

Waffled checks GitHub for new releases and shows **"Update available — vX.Y.Z"** in
**System Health**.

| Env var | Default | Meaning |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | on | Enable the release check |
| `UPDATE_CHECK_REPO` | — | Which repo to check |

When one is offered, act on it with `./waffled upgrade` — see
[Upgrading](/operations/upgrading/).

## Optional metrics & traces

Waffled can run a **local all-in-one observability stack** (Grafana / Prometheus /
Tempo / Loki) via the `observability` compose profile, and point the api's OTEL
exporter at it:

```bash
./waffled observability up      # bring up Grafana/Prometheus/Tempo/Loki
./waffled observability down     # turn it back off
```

- **Grafana** runs on **port 3001**, login **admin / admin**.
- **OpenTelemetry is OFF by default** — there's no `OTEL_EXPORTER_OTLP_ENDPOINT` set
  until you bring the stack up (or point it at your own collector).

## Logs

Tune log output in `infra/compose/.env`:

| Env var | Purpose |
|---|---|
| `LOG_LEVEL` | Verbosity |
| `LOG_FORMAT` | Log format |

## See also

- [Troubleshooting](/operations/troubleshooting/) — symptom → diagnosis → fix
- [Backup & restore](/operations/backup/) — fix a degraded backup line
- [Upgrading](/operations/upgrading/) — act on the update notifier
