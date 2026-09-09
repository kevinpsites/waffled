# `waffled-runtime` — the native server supervisor

The Go binary that runs a whole Waffled server on one Mac with no Docker. It is Phase 2
of the "Waffled for Mac" plan (`docs/product/native-mac-plan.md`, currently on the
`worktree-native-mac-plan` branch), and it is what the menu-bar app in Phase 3 will
shell out to.

Everything Docker Compose does for the Linux deployment, this does natively:
generate the secrets, lay out the data directory, create and configure a Postgres
cluster, start five things in dependency order behind health gates, restart what
crashes, and stop it all in reverse. **Compose is untouched** — the same `Caddyfile`,
`00-init.sql`, migrations, api bundle and web build serve both.

It is a **CLI first**, deliberately: nothing the GUI can do is unavailable in Terminal,
so support can say "run `waffled-runtime doctor` and paste the output".

## Commands

```sh
waffled-runtime start [--foreground] [--bundle DIR] [--data DIR]
waffled-runtime stop [--timeout 2m]
waffled-runtime status [--json]
waffled-runtime logs [service] [-f] [-n N]      # postgres migrate api powersync caddy runtime
waffled-runtime backup [--out FILE] [--keep N]
waffled-runtime backup --install-schedule | --uninstall-schedule
waffled-runtime restore FILE [--yes]
waffled-runtime doctor [--json]
waffled-runtime version
```

`--bundle` defaults to the directory **above** the binary — it ships at
`Waffled.app/Contents/Resources/runtime/bin/waffled-runtime`, so `../` is the bundle
root. `--data` defaults to `~/Library/Application Support/Waffled`.

### The daemonize decision

**The supervisor's real mode is the foreground.** `start --foreground` runs the
supervision loop in that process: it holds the children, watches them, and shuts them
down in dependency order on SIGTERM or SIGINT. That is the mode launchd wants (launchd
supervises a foreground child and is confused by one that forks away), and it is what
the Mac app and the integration test drive.

Plain `start` is a convenience for a person at a prompt. It re-execs **this same binary**
with `--foreground` in a new session (`setsid`), then waits until the public port answers,
so the command returns only once the server is genuinely usable — or fails with the
reason. It re-execs rather than double-forking because Go's runtime is multithreaded by
the time `main` runs, and forking after that is not safe.

Either way the supervising process writes `pids/supervisor.pid`, and `stop` signals it.
So `stop` behaves identically whether the stack was started by launchd, by the menu-bar
app, or by hand — and if no supervisor is running it falls back to stopping whatever
services are still up, so a half-dead stack can always be cleaned up.

## The start sequence

```text
postgres ──▶ init databases ──▶ migrate ──▶ api ──▶ powersync ──▶ caddy
 pg_isready     00-init.sql      exit 0    /healthz  /probes/liveness  /healthz
```

Stop walks it backwards, ending with `pg_ctl stop -m fast`. Every step is idempotent:
`start` against a running stack is a no-op, and a start interrupted halfway repairs
itself on the next one.

Two details worth knowing:

- **Postgres is not a supervised child.** `pg_ctl` exits as soon as the postmaster is
  accepting connections, so watching it like the Node services would read a successful
  start as an immediate crash and restart-loop forever. It is started and stopped through
  `pg_ctl` and observed through `pg_isready` and `postmaster.pid`.
- **The api's health gate is `/healthz`, not `/api/health`.** The latter is admin-only
  and answers 401; gating on it would mean either never reaching green or treating a 401
  as healthy. `/api/health` is used through Caddy in the tests, accepting 200-or-401, to
  prove the proxy path.

Crashed services come back with an exponential backoff capped at 30s — Compose's
`restart: unless-stopped`. Restart supervision is armed only *after* a service has been
healthy once, so a service that has never worked fails the start instead of looping over
the same misconfiguration.

## Data directory

Default `~/Library/Application Support/Waffled` — note the space in that path, which is
why the generated Caddyfile quotes its roots and `postgresql.conf` quotes the socket
directory.

```text
~/Library/Application Support/Waffled/
  config.env             0600 — the same variables as infra/compose/.env
  runtime.json           ports, install id, socket dir, the bundle build last used
  postgres/              PGDATA — excluded from Time Machine
  media/                 uploaded blobs (the api writes, Caddy serves)
  backups/               pg_dump output: routine backups and pre-migration snapshots
  logs/                  one file per service, rotated at 10 MB (one generation kept)
  pids/                  supervisor.pid + one per supervised child
  powersync/             PowerSync's working dir: its config + the .probes/ it creates
  caddy/                 XDG_DATA_HOME / XDG_CONFIG_HOME for Caddy's own state
  Caddyfile              generated from the bundle's compose Caddyfile
  bundle-verified.json   memo: this bundle build verified, so warm starts skip the walk
```

### Secrets

Generated once on first run, in the same formats `ensure_env` in the repo-root `waffled`
script produces — the same api binary validates them either way:

| Variable | Format |
|---|---|
| `LOCAL_JWT_SECRET` | base64 of 48 random bytes |
| `TOKEN_ENCRYPTION_KEY` | base64 of 32 random bytes (standard alphabet, padded — the api requires `length % 4 == 0`) |
| `POSTGRES_PASSWORD` | hex of 24 random bytes — **hex, not base64**, because it is interpolated into `postgres://` URLs and a `/` breaks them |
| `POWERSYNC_JWT_PRIVATE_KEY` | RSA-2048 PKCS#8 PEM, base64'd onto one line |

`config.env` is rewritten line by line, so an operator's own additions (an AI provider
key, Google OAuth credentials) and their comments survive; those keys are passed through
to the api, so a native install is as capable as the Docker one.

### Postgres and the `en_US.UTF-8` decision

The cluster is created with:

```sh
initdb -U waffled --pwfile=… --auth=scram-sha-256 --encoding=UTF8 --locale=en_US.UTF-8
```

**The locale is `en_US.UTF-8`, not the `C` locale the Phase 1 spike used.** The Docker
`postgres:16` image initializes its clusters as `en_US.utf8` (verified on the live
stack: `datcollate = en_US.utf8`), and a family moving from Docker to the Mac app by
restoring a dump has to keep the same text collation. A different one silently changes
sort order and makes every index report a collation-version mismatch.
`TestClusterCollationMatchesTheDockerImage` asserts `datcollate`/`datctype` on both
databases, and `doctor` re-checks it on an existing install.

The managed block in `postgresql.conf` is rewritten on every start (so a port that moved
takes effect) and sets `listen_addresses='127.0.0.1'`, `wal_level=logical`,
`max_replication_slots=10`, `max_wal_senders=10` and `password_encryption=scram-sha-256`.
`pg_hba.conf` is entirely ours: **scram everywhere, never `trust`**, loopback only, and
with the `replication` rules PowerSync's logical slot needs — omit those and liveness
still goes green while only replication is dead.

macOS caps a unix socket path at 104 bytes. When PGDATA's path is too long for that (a
deep temp directory, say) the socket goes in a short directory instead, and
`runtime.json` remembers which so it stays stable across restarts.

`postgres/` gets a Time Machine exclusion via `tmutil addexclusion` (which sets
`com.apple.metadata:com_apple_backup_excludeItem` and needs no admin rights on a path the
user owns). Restoring a *live* cluster from a file-level backup produces a corrupt one;
`backups/` is what should be backed up. Failing to set it is a warning, never a failed
start.

Once set, the answer is remembered in `runtime.json` and **trusted without re-asking**:
the exclusion is asserted when a Supervisor is constructed, and `status` constructs one on
every poll, so verifying it there would fork `tmutil` once a second behind the menu-bar
app. `doctor` asks tmutil live instead — an exclusion someone removed by hand shows up the
moment a human runs the command that exists to re-check settled questions.

## Ports

| | Default | Bind | Chosen by |
|---|---|---|---|
| public HTTP (Caddy) | 8080 | wildcard | first run, then fixed |
| public PowerSync (Caddy) | 8081 | wildcard | first run, then fixed |
| api | 3000 | 127.0.0.1 | first run, then fixed |
| powersync | 8082 | 127.0.0.1 | first run, then fixed |
| postgres | 5432 | 127.0.0.1 | first run, then fixed |

The policy is deliberately asymmetric. **On a first run** a taken default is fine — the
next free port is used and recorded. **On later runs** a recorded port held by something
else is a hard error, because every phone, tablet and bookmark in the household points at
the public one, and silently moving would look like the server had vanished. A port held
by one of our own live services is fine, so `start` stays idempotent.

All five are allocated in **one pass with a single exclusion list spanning both scopes**.
Two passes is what once put Caddy's public site and PowerSync's service on the same port:
with Docker holding 8080 and 8081, the public site falls forward to 8082, which is
PowerSync's own default and was still unbound at selection time.

Probes are made in the scope a service will actually bind — a 127.0.0.1-only probe
reports Docker's `*:8080` as free right up until Caddy fails to bind it.

### Network confinement — what holds today, and what doesn't

Plan §5 replaces Compose's private network with loopback binding. Where that stands:

- **Postgres is loopback-only.** Asserted by the integration test. This is the one that
  matters most: it is the data, and there is no container boundary in front of it now.
- **The api still binds `0.0.0.0`.** It honours `HOST` only once PR #177 merges. The
  runtime already passes `HOST=127.0.0.1`, so the day that lands the binding is correct
  with no change here.
- **PowerSync binds `0.0.0.0` and cannot currently be confined.** `host: '0.0.0.0'` is
  hardcoded in its own listen call (`modules/module-core`, `CoreModule`); there is no
  config key and no `PS_*`/`POWERSYNC_*` variable for it. Requests still need an RS256
  token our api minted, so this is a **missing layer of defence rather than an open
  door** — but it means the sync service is reachable on the LAN directly, bypassing
  Caddy. The fix is upstream, or a packet-filter rule outside this binary.

The integration test records the last two as named gaps that turn into passes — and tell
you to delete the exemption — the day either is fixed.

## The bundle contract

The runtime refuses to execute anything until the bundle matches its `manifest.json`:
set equality on files **and symlinks**, sha256 per file, the owner-exec bit, and
`arch`/`platform` against this machine. It is a port of `manifest.mjs verify` from
`infra/native/bundle/` (branch `native-bundle`), whose README is the interface this
implements.

Symlinks are recorded and **never followed** — `bin/postgres/lib` has 17 relative links
without which `postgres` dies at dyld time, and PowerSync's `node_modules` is a 1,321-link
pnpm farm.

Verifying the real bundle (36,456 files, 1,338 symlinks, 580 MB) takes ~1.5s, so the
result is memoized in `bundle-verified.json`, keyed on three things: the bundle path, the
sha256 of `manifest.json`, and a stat fingerprint (size + mtime) of every path that
manifest lists. The manifest hash alone would not be enough — it changes with the build,
but a bundled file altered in place leaves it untouched — so the fingerprint is what lets
the memo claim the bundle has not changed since it was verified. Any listed file that has
been changed, replaced or removed misses the memo and pays the full walk, which then
refuses it. The fingerprint costs ~115ms warm (36k lstats, no content read), so a warm
start pays ~145ms rather than the 35ms it paid when the memo was only trusting
`manifest.json` — still a tenth of the 1.5s full walk, and now actually load-bearing.

Versions shown by `status` come from the manifest, not from running `--version`. The
api is given `GIT_SHA` and `BUILD_TIME` from it too, so System Health reports real
provenance instead of `"sha":"dev"`.

## `status --json`

The contract the menu-bar app polls. `schema` is versioned; fields are added, never
renamed.

```jsonc
{
  "schema": 1,
  "state": "running",            // stopped | starting | running | unhealthy
  "dataDir": "/Users/…/Application Support/Waffled",
  "bundleDir": "/Applications/Waffled.app/Contents/Resources/runtime",
  "urls":     { "local": "http://127.0.0.1:8080", "lan": "http://192.168.1.5:8080",
                "powersync": "http://192.168.1.5:8081" },
  "ports":    { "public": 8080, "powersyncPublic": 8081, "api": 3000,
                "powersync": 8082, "postgres": 5432 },
  "versions": { "waffled": "0.14.3", "node": "24.19.0", "postgres": "16.14",
                "caddy": "2.11.4", "powersync": "1.22.0", "api": "0.14.3", "web": "0.14.3" },
  "bundle":   { "gitSha": "a506c352", "builtAt": "2026-09-04T23:48:42.438Z",
                "arch": "arm64", "platform": "darwin", "verified": true },
  "supervisor": { "pid": 4242, "running": true },
  "services": [
    { "name": "postgres", "state": "running", "pid": 101, "port": 5432,
      "health": "ok", "restarts": 0, "lastError": "", "log": "/…/logs/postgres.log" }
    // api, powersync, caddy
  ],
  "lastError": "",
  "generatedAt": "2026-09-08T16:20:00Z"
}
```

Service states: `stopped` (not running), `starting` (up, health not green yet),
`running` (up and healthy), `unhealthy` (gone when it should not be, or failing its
health check). The overall `state` is derived: a stopped service beside running ones is
`unhealthy`, not `starting` — that distinction is what the menu-bar icon needs.

`status` and `doctor` deliberately **tolerate a port conflict** rather than refusing to
run, because a stolen port is the most likely reason someone runs either of them. The
conflict is reported in `lastError` and by `doctor`'s own port check. `start` still fails
hard.

The `backups` block is added to the same document:

```jsonc
"backups": {
  "dir": "/Users/…/Waffled/backups",
  "lastBackupAt": "2026-09-08T03:00:00Z",
  "lastPath": "/Users/…/backups/waffled-20260908-030000.dump",
  "lastSizeBytes": 4823104,
  "lastMigration": "0099_rhythm_book_within",
  "count": 14,
  "lastError": "", "lastErrorAt": "",
  "scheduleInstalled": true
}
```

`schema` stays at **1**: the block is additive and no existing field changed meaning.

It is derived from the **filesystem**, never from the `backup_runs` table. "When did it
last back up?" is asked exactly when the server is stopped, and a block that needed
Postgres would go blank at the only moment it mattered. `backup_runs` is the same facts
mirrored for the api, which can only be asked when the api is up anyway. For the same
reason `scheduleInstalled` is a `stat` of the plist rather than a `launchctl print` — the
menu-bar app polls this, and a process spawn per poll is not free.

## Backup and restore

```sh
waffled-runtime backup                       # → backups/waffled-<UTC stamp>.dump
waffled-runtime backup --out /Volumes/…/x.dump
waffled-runtime backup --install-schedule    # nightly at 03:00, via launchd
waffled-runtime restore backups/waffled-20260908-030000.dump
```

`backup` takes a **custom-format** (`pg_dump -Fc`) dump of the application database,
writing under a temporary name and renaming on success — a dump only matters once
something has already gone wrong, so a half-written one left by a crash must never look
usable. PowerSync's `powersync_storage` database is deliberately **not** dumped: it holds
derived bucket data, and restoring it beside an older application database would leave
the two disagreeing. It is rebuilt from the restored data instead.

Beside each dump goes a small `<name>.dump.json` **sidecar** recording the Waffled
version, git sha, migration level, database and collation. A dump does not otherwise say
what it is — `pg_restore`'s table of contents names the `pgmigrations` table but not its
rows — so without it, answering "what schema is this?" means unpacking the whole file.

**One backup runs at a time**, enforced by an `flock` on `backups/.lock` held for the
whole run. The 03:00 launchd job and a "Back up now" click can land in the same second,
and dump names are second-resolution — so without it both runs computed the same file and
the same `.part` beside it, one unlinking the other's in-progress dump and either of them
able to rename a half-written file onto the canonical backup name while `status` and
`doctor` called it healthy and current. A second run **waits** rather than failing (it
takes its own dump a moment later; a clean refusal would have to be recorded as a failed
nightly backup and shown as one), and the dump's name is chosen *under* the lock so two
queued runs cannot collide. `flock` rather than a pidfile because the kernel drops it when
a process dies — a stale lock at 03:00 on a Mac nobody is sitting at is not recoverable.

**Backup works with the server stopped.** If nothing is running it starts Postgres alone,
dumps, and stops it again, leaving the machine as it found it. The alternative — refusing
unless the stack is up — would make the nightly job silently useless on exactly the Macs
it matters on, because a launchd *user agent* only runs while someone is logged in and
nobody sits at a Mac they left running as a server.

### Restore

`restore` refuses without `--yes` unless a terminal confirms by typing `restore`. Then it
stops the **whole stack**, not just the three app services `./waffled restore` stops:
natively a supervisor process holds the children and re-arms restarts once a service has
been healthy, so signalling the api directly would just have our own code bring it back
mid-restore. It drops PowerSync's replication slot and its storage database, drops and
recreates the application database, loads the dump, and returns with everything stopped;
the caller starts the stack again, which re-runs migrations to catch up an older dump and
lets `00-init.sql` rebuild PowerSync's storage.

Dropping and recreating rather than `pg_restore --clean` is deliberate: a restore should
produce exactly what the dump holds, and `--clean` leaves behind anything the dump does
not mention.

**A dump taken at a migration newer than this bundle ships is refused.** That is the one
unrecoverable direction — migrations only run forward, so a database ahead of its code
has nothing to migrate back down with. The check happens *before* anything is stopped, so
a household never loses a running server to a restore that was never going to be allowed
— and without starting anything either: the dump's level comes from its sidecar or from
`pg_restore --file -`, which reads the file and connects to nothing, and the bundle's is a
directory listing.

`.sql` and `.sql.gz` dumps are accepted too, streamed into `psql` without ever
materialising the decompressed file. That is the **Docker-to-Mac path**: the file a
family carries over is whatever their Compose backup sidecar wrote, and it will have no
sidecar JSON, so the migration level is read out of the gzip stream instead.

### Snapshot before migrating, and automatic rollback

Plan §5: *rollback means restore, not reverse migrations.* Before `start` runs migrations
it checks whether any are actually pending — comparing the bundle's migration **names**
against `pgmigrations`, because the api runs node-pg-migrate with `checkOrder:false` and
a database can legitimately hold a later migration while an earlier one is still pending.
If any are, it dumps to `backups/pre-migrate-<version>-<stamp>.dump` first.

If the api then fails its health gate, that snapshot is **restored automatically** and
the start fails, naming the file. The rollback stops **PowerSync as well as the api**
before it touches the database. PowerSync has normally not been started at that point —
the start sequence reaches it only after the gate that just failed — but one left behind
by a supervisor that died is still streaming, and an *active* replication slot cannot be
dropped, so the rollback would fail exactly where it matters most. Dropping a slot also
terminates whatever holds it and retries while the walsender lets go, the same shape
`DROP DATABASE` already needed. A first run takes no snapshot: there is nothing yet to
lose. A snapshot that *cannot* be taken stops the start, matching `run_pre_upgrade_backup`
in the repo-root `waffled` script — going through a schema change with no way back and
finding out afterwards is the failure this exists to prevent.

### Retention

Two pools share `backups/` and are pruned separately by prefix: **14** `waffled-*.dump`
and **3** `pre-migrate-*.dump`. A pruner that globbed `*.dump` would quietly eat the
rollback points every night. Pruning runs **whether or not the dump succeeded** — on a
full disk, deleting what is beyond `keep` is the only thing in the command that frees
space, and gating it on success means the next night fails the same way for good. It
costs a household nothing: retention removes only files *beyond* the limit, so a failed
run in a directory holding `keep` or fewer removes none at all. Snapshots are ordered by
their parsed timestamp, not their name — sorting `pre-migrate-0.9.0-…` as a string puts
it after `0.14.3` and would delete the newest.

### Schedule

`backup --install-schedule` writes `~/Library/LaunchAgents/app.waffled.backup.plist`
(`StartCalendarInterval` 03:00, `RunAtLoad` false) and loads it with
`launchctl bootstrap gui/$UID`. Every path in it is absolute and `--data` is baked in,
because a launchd agent gets a minimal environment and no working directory it can rely
on. The plist is built with `encoding/xml`, not string concatenation: a household under
`/Users/sam & jo` would otherwise get a file launchd silently refuses to parse and a
backup that never runs with nothing to show for it. Output goes to `logs/backup.log`.

A **failed bootstrap takes the plist with it**. "The plist is on disk" and "launchd holds
the job" are different facts, and everything that polls — `status`, the menu bar — can
only afford the first (an `os.Stat`, not a `launchctl` fork per second). So a file left
behind by a bootstrap that failed would be reported as an installed nightly backup
forever, while nothing ran. `doctor` closes the remaining gap: once, when a human asks, it
runs `launchctl print gui/$UID/app.waffled.backup` and warns if the job someone installed
is not actually loaded.

### Four deliberate differences from the Compose path

Recorded because each looks like a bug to anyone who reads only one side:

| | Compose sidecar | Here | Why |
|---|---|---|---|
| format | plain SQL + gzip | `pg_dump -Fc` | custom format can be asked for one table, which is how a dump's migration level is read before committing to a restore |
| retention | age (`find -mtime +14`) | count (last 14) | a family Mac asleep for a fortnight would wake to an age-based pruner having deleted every backup it had and taken no new one |
| `backup_runs` on restore | n/a | **not written** | the table has a `kind` column but the api reads `where status in ('success','failed') order by finished_at desc limit 1` with no filter on it, so a restore row would be reported as "the last backup" and a household that restored last week would be told its backups were current |
| `BACKUP_ENABLED` | `true` | `true` (was `false`) | the api short-circuits its backup health check to "turned off" on `false`, which would hide the rows the runtime writes — a nightly backup failing for a week would look exactly like one succeeding for a week |

## Tests

```sh
cd apps/runtime
go test ./...                                                    # unit, hermetic, ~15s
WAFFLED_BUNDLE=/path/to/runtime go test -tags integration -p 1 ./...   # the real stack
go vet ./... && gofmt -l .
```

The unit tests cover the things that are easy to get subtly wrong and expensive to
discover late: secret formats (including a base64 → PEM → `ParsePKCS8PrivateKey`
round-trip), port selection against genuinely occupied ports, `runtime.json`
round-tripping, the Caddyfile rewrite (both `api:3000` occurrences, paths with spaces,
and a drift alarm that rewrites the repo's *real* `infra/compose/caddy/Caddyfile`),
manifest verification against tampered/extra/missing/retargeted fixtures, process
supervision, log rotation, and the status contract.

The integration tests (build tag `integration`, skipped without `WAFFLED_BUNDLE`) run the
real bundle into a temp data directory **whose path contains a space**:

- `TestStackComesUpAndBackDown` — cold start, all four services running, `/healthz`,
  `/api/health` through Caddy, PowerSync liveness on both ports, the JWKS endpoint,
  Postgres proven loopback-only.
- `TestRestartReopensTheSameData` — stop leaves nothing listening; the second start
  reuses the same ports and secrets, does not re-`initdb`, and applies zero migrations
  (asserted by counting `pgmigrations` rows, not by grepping a log).
- `TestClusterCollationMatchesTheDockerImage` — `datcollate`/`datctype` on both databases.
- `TestDetachedStartStop` — builds the real binary and drives `start` → `status --json`
  → `doctor` → `stop`, which is the only test that exercises the daemonize path.
- `TestATamperedBundleIsRefused` — a bundle that does not match its manifest never runs.
- `TestBackupAndRestoreRoundTrip` — write a row, back up, destroy it, restore, and find
  it again with every service green. It reads `backup_runs` back with the api's **own
  query**, so a drifted column shows up here rather than as a blank panel in System
  Health, and it asserts PowerSync has an **active replication slot** on the restored
  database — liveness alone answers perfectly well while the service syncs nothing.
- `TestRestoreAcceptsAComposeSidecarDump` — the Docker-to-Mac path, against a file built
  with `backup.sh`'s exact flags rather than one of ours.
- `TestRestoreRefusesADumpNewerThanTheBundle`, `TestRestoreRefusesWithoutConfirmation` —
  and neither refusal stops the running server.
- `TestRetentionKeepsTheLastNAndLeavesSnapshotsAlone`.
- `TestSnapshotIsTakenAndRolledBackWhenTheAPIFailsToStart` and
  `TestBackupWorksWithTheServerStopped` live in `internal/supervisor` rather than here,
  because forcing the post-migrate health gate to fail has to be done **without shipping
  a way to do it**: `Supervisor.waitHealthy` is an unexported field, always `waitHTTP` in
  production, and only a test inside the package can swap it. Every line of the start
  sequence then runs exactly as it does on a real Mac, with no environment variable or
  flag a household could trip into a fake failure. The test rewinds the database for real
  (running `0096_recipe_views`' own Down SQL) rather than only deleting its
  `pgmigrations` row — deleting the row alone makes node-pg-migrate re-run an Up whose
  objects still exist, so the migration fails and nothing ever reaches the gate. It then
  asserts the restored state is the **pre-migration** one specifically, since a snapshot
  taken a moment too late would still restore something and still look like it worked.

Run the integration suite with `-p 1`: without it Go runs packages concurrently and two
stacks race for the same ports.

Measured on an M-series Mac with Docker holding 8080/8081/8090/3000/5432, so every
default fell forward (public 8082, sync 8083, api 3001, powersync 8084, postgres 5433):

| | |
|---|---|
| cold start, in-process (`Supervisor.Start`) | **14.9s** |
| cold start via the CLI, detached | **17.1s** — the parent and the re-exec'd child each verify the bundle on a cold cache |
| warm restart | **2.3s** |
| bundle verify (36k files, 580 MB) | 1.5s cold, 35ms memoized |

The plan's Phase 2 exit criterion is under 60s; the test fails if a cold start exceeds it.

## Not this task

Bonjour advertisement and the updater are deliberately absent, with seams left for them.
The updater's flow — snapshot → stop → swap the runtime → migrate → health → restore on
failure — is the sequence `start` already runs, so it should reuse `ensurePostgres`,
`snapshotBeforeMigrate`, `rollbackTo`, `replaceDatabase` and `backup.CheckRestorable`
rather than growing a second copy. It will want its **own** retention prefix beside
`pre-migrate-`: a snapshot taken before swapping binaries answers a different question
from one taken before a schema change, and sharing a pool would let either evict the
other.

## Portability

Standard library only — no third-party dependencies, no cgo. macOS-specific behaviour
(the default data directory, the Time Machine exclusion) sits behind `//go:build darwin`
with a no-op sibling, so the core still cross-compiles for the Windows work parked in
plan §9.
