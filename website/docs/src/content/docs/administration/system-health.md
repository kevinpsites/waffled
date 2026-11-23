---
title: System health
description: Check that Waffled is healthy — the health panel, the health endpoints, and metrics.
---

Waffled ships a **deep health report** covering **db, migrations, jobs, calendar,
storage, and backup**. This page is how you read it, plus the optional OpenTelemetry export.
For symptom → fix, see [Troubleshooting](/operations/troubleshooting/).

## Ways to see health

| Method | Depth | Who | Notes |
|---|---|---|---|
| **Settings → System Health** | deep | admin | The report, in the UI |
| `GET /api/health` | deep, per-component JSON | admin | Machine-readable full report |
| `GET /healthz` | shallow | public | DB ping + version/build info; backs the container healthcheck (`docker compose ps`) |

`/healthz` drops straight into an uptime monitor.

## Reading the report

### Backup line

The **backup** line turns **degraded** if the **last backup failed**, or the **newest
success is older than ~48 h** (two missed daily cycles). Backups are optional: unless you set
`BACKUP_ENABLED=true`, the line just says automatic backups are off. Fix it via
[Backup & restore](/operations/backup/).

### Migrations line

The **migrations** line flags **"schema behind"** when **applied < available**. Migrations
run every time the app starts, so check `docker compose logs waffled` and restart:

```bash
docker compose up -d
```

## Update notifier

Waffled checks GitHub for new releases and shows **"Update available — vX.Y.Z"** in
**System Health**.

| Env var | Default | Meaning |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | on | Enable the release check |
| `UPDATE_CHECK_REPO` | `evan-ribbey/waffled-ng` | Which repo to check |

When one is offered, act on it with `docker compose pull && docker compose up -d` — see
[Upgrading](/operations/upgrading/).

## Optional traces

OpenTelemetry is **off by default**. The bundled Grafana stack was removed in 0.16, but the app
still exports traces and metrics to any collector you run: set `OTEL_EXPORTER_OTLP_ENDPOINT`
(for example `http://otel-collector:4318`) in `.env` and run `docker compose up -d`.

## Logs

Tune log output in `.env`:

| Env var | Purpose |
|---|---|
| `LOG_LEVEL` | Verbosity |
| `LOG_FORMAT` | Log format |

View them with `docker compose logs -f waffled`.

## See also

- [Troubleshooting](/operations/troubleshooting/) — symptom → diagnosis → fix
- [Backup & restore](/operations/backup/) — fix a degraded backup line
- [Upgrading](/operations/upgrading/) — act on the update notifier
