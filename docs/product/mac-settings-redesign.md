# Waffled for Mac — the Settings redesign, and what has to exist first

Follow-up plan. **Nothing in this document is built.** It records a design that landed
after PR #202 and, more importantly, the audit of which of its controls would actually do
something today — because most of them would not, and shipping a settings screen full of
fields that silently change nothing is the failure this plan exists to prevent.

Design: the Claude Design project, `Waffled for Mac - Setup Flow.html` (with `mac-setup.css`
and `mac-setup.js`). Companion to [`native-mac-plan.md`](./native-mac-plan.md) §7 Phase 3.

---

## 1. Why this is its own task

PR #202's worst bug — the one the review pass existed to catch — was `HTTP_PORT`: a field
on the setup screen that looked like it worked and silently discarded what a household
typed. One field.

The redesigned Settings screen adds roughly **forty**. Against today's code, about
**two-thirds of them would behave the same way**: accepted, written, and ignored. A screen
whose entire job is to be trusted cannot ship like that, and the fix is not to hide the
problem behind an "advanced" tab — it is to make each control real, or leave it out until
it can be.

So this is a plan for **the runtime work first**, and the UI second.

## 2. What the design adds

Structurally, on top of what #202 shipped:

- **Tabs** on the settings screen — *Basic* / *Advanced* / *Diagnostics* — with the title
  and sub-line changing per tab.
- **Drawer rows** in Basic: each row's `Change…` expands an inline drawer and becomes
  `Done`, instead of showing every control at once. This is the fix for the scrolling
  problem #202's flat list has at 940×648.
- **A provider segment** for smart suggestions — *Not now · Claude · OpenAI-compatible ·
  Ollama* — with Ollama detected on the Mac and reported inline.
- **Advanced**: address and ports, AI model and limits, calendar sync (Google and
  Microsoft), sessions and sign-in, rate limits, offsite backup, and a free-form
  `KEY=VALUE` table.
- **Diagnostics**: log level and format, a rolling log file, OpenTelemetry, update channel.
- The welcome step's quiet button becomes **`Settings first…`**.

## 3. The audit — what is real, and what is not

The native runtime does **not** forward `config.env` to the api wholesale. It builds the
api's environment explicitly (`apps/runtime/internal/services/services.go`, `Plan.API`) and
then passes exactly one allowlist through — `passthroughKeys`, same file:

```
ANTHROPIC_API_KEY  ANTHROPIC_MODEL
OPENAI_API_KEY     OPENAI_MODEL      OPENAI_BASE_URL
OLLAMA_HOST        OLLAMA_MODEL
GOOGLE_CLIENT_ID   GOOGLE_CLIENT_SECRET  GOOGLE_CALENDAR_REDIRECT_URI  GOOGLE_CALENDAR_SCOPES
MS_CLIENT_ID       MS_CLIENT_SECRET      MS_CALENDAR_REDIRECT_URI      MS_CALENDAR_SCOPES
TZ
```

Anything else written to `config.env` reaches nothing. That single fact decides most of
what follows.

### 3a. Real today — build the UI, no runtime work

| Control | Key / mechanism |
|---|---|
| Smart suggestions: Claude, OpenAI-compatible, Ollama | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OLLAMA_HOST` — all allowlisted |
| Advanced → AI model | `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `OLLAMA_MODEL` — allowlisted |
| Advanced → Calendar sync, both providers | `GOOGLE_*`, `MS_*` — allowlisted, and the api reads them |
| Address on the network | `WAFFLED_PUBLIC_HOST` — the runtime's own, shipped in #202 |
| Nightly backup on/off and time | `backup --install-schedule --at HH:MM` — shipped in #202 |
| Start at login | `SMAppService`, the app's own |
| The `TZ` row of the KV table | allowlisted |

### 3b. Read by the api, but not forwarded — one line each

These are the cheap ones. The api already reads every one; they are simply not in
`passthroughKeys`. **Adding them there makes the design true**, with no other change:

`PUBLIC_BASE_URL` · `AI_TIMEOUT_MS` · `AI_MAX_RETRIES` · `ACCESS_TOKEN_TTL_SECONDS` ·
`REFRESH_TOKEN_TTL_DAYS` · `OIDC_NATIVE_REDIRECT_URI` · `AUTH_FORCE_PASSWORD` ·
the eight rate-limit keys (`SETUP_MAX`, `LOGIN_ACCOUNT_MAX`, `LOGIN_IP_MAX`,
`OIDC_START_MAX`, `REFRESH_MAX`, `KIOSK_PAIR_MAX`, `KIOSK_TOKEN_MAX`, `MEDIA_MAX`) ·
`OTEL_SDK_DISABLED` and the four other `OTEL_*` keys · `UPDATE_CHECK_REPO`

⚠️ **Widening an allowlist is a security decision, not a formality.** It exists so that a
hand-edited `config.env` cannot reach into the api's environment arbitrarily. Each key
added should be one a household is meant to set. Do not replace the list with a
pass-everything rule.

### 3c. Hardcoded by the runtime — remove the hardcode first

`Plan.API` sets these itself, so a `config.env` value would be shadowed:

| Key | Today | What is needed |
|---|---|---|
| `LOG_LEVEL` | `info`, hardcoded | read from `config.env`, keep `info` as the default |
| `LOG_FORMAT` | `json`, hardcoded | same. The design offers "Readable text" — check the api honours a non-JSON value before offering it |
| `MEDIA_DIR` | `<data>/media`, hardcoded | see 3d — this one is not just a passthrough |

### 3d. Needs real work — features, not settings

Do not put these on the screen until they exist. Each is its own task.

1. **Media in a different folder** (`MEDIA_DIR` in the design). The runtime pins media
   inside the data directory, `uninstall` and `move` both assume that, and Time Machine
   exclusion is applied to `postgres/` on the same assumption. Splitting it means teaching
   all three about a second location. **The design's reason is good** — photos are the part
   that grows — so this is worth doing, just not incidentally.
2. **Backups in a different folder** (`BACKUP_HOST_PATH`). Nothing anywhere reads this key.
   Same shape of problem as media, plus the nightly launchd job's `--out`.
3. **Backup retention.** The design offers 7/14/30/90/Forever. This one is *nearly* free:
   the runtime already has `backup --keep N`, but the installed launchd plist does not pass
   it, so the schedule always uses the default of 14. Passing `--keep` through
   `schedule.Agent` is a small, contained change — probably the best value in this list.
   "Forever" needs `--keep 0` to mean "keep everything", which it does not today.
4. **Include photos in the backup.** `backup` dumps the database only. Media is not in it.
   The design's toggle implies an archive format that does not exist.
5. **Offsite copy to S3/B2/R2** (`BACKUP_S3_*`). Nothing reads these keys in either the api
   or the runtime; there is no uploader. This is the largest item here and is a feature in
   its own right.
6. **A hostname Caddy actually serves** (`CADDY_SITE_ADDRESS`). The native runtime generates
   its own Caddyfile from `internal/caddyconf`; the compose key does not apply. Today
   `WAFFLED_PUBLIC_HOST` changes what devices are *told*, not what Caddy answers to. A real
   custom hostname with a certificate is a bigger job — and the plan's "no TLS on the LAN"
   decision (§6) is the thing to revisit first.
7. **Update channel — Stable / Beta.** Sparkle has one feed URL, baked into `project.yml`.
   A channel switch means a second appcast and a way to choose between them.

### 3e. Deliberately not built, and why

- **The "Port in use" screen.** The runtime falls forward past a busy port and never fails
  on one, so this screen describes a state that cannot occur. The design's port field also
  *gates* `Set up Waffled` on a free port; the runtime's whole behaviour here is that a
  household should never have to think about it. Keep the ready step's
  "Using port 8082 because 8080 was busy" note instead. (Also the original P3 spec's call.)
- **An editable port after setup.** `HTTP_PORT` is the preference for the FIRST allocation
  and nothing after it, because every phone, tablet and bookmark in the house points at the
  published one. Advanced shows a port field; it must stay read-only there, with the note
  #202 already ships.
- **Database credentials.** The design correctly leaves them out; the runtime generates and
  owns them.

## 4. Suggested order

1. **`backup --keep` through the schedule** (3d item 3). Smallest real gap, immediate value.
2. **Widen `passthroughKeys`** for the 3b list, deliberately, key by key.
3. **Un-hardcode `LOG_LEVEL` / `LOG_FORMAT`** (3c).
4. **Build the UI**: tabs, drawer rows, the provider segment. Everything from 3a and 3b is
   live by this point; nothing dead ships.
5. Then, separately and in their own PRs: media relocation, backup relocation, retention
   beyond `--keep`, offsite copy, the Caddy hostname, the update channel.

## 5. The rule this whole plan is about

**A control that does nothing is worse than no control.** It is a promise a household acts
on — moves their photos, sets a retention they believe in, turns on a rate limit they think
protects them — and it is silently untrue. Every field on this screen must either write
something that is read, or not be there yet.

---

*Audited against `mac-setup-flow` at the tip of PR #202. If `passthroughKeys` or `Plan.API`
have moved since, re-run the audit before trusting §3.*
