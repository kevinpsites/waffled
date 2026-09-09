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
waffled-runtime logs [service] [-f] [-n N]      # postgres migrate api powersync caddy bonjour runtime
waffled-runtime backup [--out FILE] [--keep N]
waffled-runtime backup --install-schedule | --uninstall-schedule
waffled-runtime restore FILE [--yes]
waffled-runtime doctor [--json]
waffled-runtime uninstall [--delete-data] [--dry-run] [--json] [--yes]
waffled-runtime version
```

`--bundle` defaults to the directory **above** the binary — it ships *inside* the bundle it
supervises, at `Waffled.app/Contents/Resources/runtime/bin/waffled-runtime`, so `../` is the
bundle root and neither the app nor a person has to pass the flag. `--data` defaults to
`~/Library/Application Support/Waffled`.

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

Once Caddy answers, the Bonjour advertiser starts — after the sequence, not inside it,
because an advertisement is a promise that something is there to reach. It is withdrawn
first on the way down, and it cannot fail a start (see [Bonjour](#bonjour)).

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

"Healthy once" needs a definition for the one child with nothing to poll (the Bonjour
advertiser): it is given half a second to prove it means to stay, and a process gone
inside that window is a **start failure** returned to the caller, not a started service.
For the advertiser that failure is never fatal and never silent: the reason is recorded in
`bonjour.json`, and because the attempt put nothing on the network the setup poll simply
tries again on its next tick, a minute later. That retry is deliberately uncapped — one
attempt a minute is a pace, not a loop, and the usual cause (the Local Network prompt not
answered yet) is a condition that becomes true later on its own.

The cap is the *other* path. The advertiser is the only child whose restarts are capped, and
that budget belongs to a dns-sd that got **past** the start window and then flapped: five
immediate deaths in a row and supervision gives up, records why in `bonjour.json` and logs
it once, because a dns-sd mDNSResponder has refused will not start working on the fiftieth
attempt. Giving up is safe precisely because that child is advisory. Every other service
still retries forever: a database that keeps dying should keep trying to come back.

## Data directory

Default `~/Library/Application Support/Waffled` — note the space in that path, which is
why the generated Caddyfile quotes its roots and `postgresql.conf` quotes the socket
directory.

```text
~/Library/Application Support/Waffled/
  config.env             0600 — the same variables as infra/compose/.env
  runtime.json           ports, install id, socket dir, the bundle build and version last used
  postgres/              PGDATA — excluded from Time Machine
  media/                 uploaded blobs (the api writes, Caddy serves)
  backups/               pg_dump output: routine backups and pre-migration snapshots
  logs/                  one file per service, rotated at 10 MB (one generation kept)
  pids/                  supervisor.pid + one per supervised child
  powersync/             PowerSync's working dir: its config + the .probes/ it creates
  caddy/                 XDG_DATA_HOME / XDG_CONFIG_HOME for Caddy's own state
  Caddyfile              generated from the bundle's compose Caddyfile
  bundle-verified.json   memo: this bundle build verified, so warm starts skip the walk
  bonjour.json           what the running supervisor is advertising, for `status` to read
```

One thing the runtime owns lives **outside** this root: when the path above is too long
for a unix socket, Postgres's socket goes in a `wfl*` temp directory instead and
`runtime.json` is the only record of where. `uninstall` is what cleans that up.

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

## Bonjour

The server advertises itself on the local network as **`_waffled._tcp`**, on the public
Caddy port — the only port another device should ever reach. This is how the iOS "Find
your Waffled server" screen (plan §7 Phase 4) finds a Mac nobody has typed an address for.

It runs `/usr/bin/dns-sd -R` as **one more supervised child**, started once Caddy is
answering and stopped first on the way down. That is a deliberate choice over a Go mDNS
library: registering through the system mDNSResponder means nothing new binds 5353 (a
second responder beside it is the classic macOS flake), `go.mod` stays stdlib-only, and
the registration is withdrawn automatically when that process is killed.

What it does **not** do is die with the supervisor. Children are spawned into their own
process group, so a supervisor that is SIGKILLed leaves dns-sd running and mDNSResponder
still publishing. That is why the next start adopts the orphan (stopping it before
registering again) and why `status` trusts the advertiser's pidfile, not the pid recorded
in `bonjour.json`, for whether anything is on the network.

It is **advisory**. It is not in `Children()`, not in `Order`, not in `PortChecks`, and not
in the `services` array `status` emits, so a Bonjour failure can never make a working
server look broken or turn the menu-bar icon red. A household that cannot be discovered
still has a server every browser and every device typing the address in can reach.

### The TXT contract

This is what a client parses. Keys are added, never renamed or repurposed — a shipped iOS
build will be reading them long after this runtime has moved on.

| Key | Value |
|---|---|
| `txtvers` | `1`. A client that finds a version it does not know should ignore the record rather than guess. |
| `name` | The instance name, repeated in the TXT so a client need not un-escape the DNS-SD instance label. |
| `url` | The address to open: the LAN URL (`http://192.168.1.5:8080`), or `http://<host>.local:<port>` when this Mac has no routable address. |
| `port` | The public Caddy port, as decimal text. Also the SRV port. |
| `version` | The bundle's Waffled version, so a client can refuse a server too old to talk to. |
| `setup` | `1` on an install with **no household yet** — a phone that finds it should say "finish setup on your Mac" rather than offer to sign in. `0` otherwise. |

Byte limits are enforced where the wire imposes them: the instance name is truncated to 63
bytes and each `key=value` to 255, both on a rune boundary, because household names are
typed by people. Values are passed as argv straight to `execve` and are **not** escaped: a
household called `Kevin's Home` travels as one argument with real spaces in it.

### The instance name, and `setup`

- Exactly one household → **the household's name** (`The Seinfelds`).
- Zero households → **`Waffled on <computer name>`** (`scutil --get ComputerName`, falling
  back to the hostname) and `setup=1`.
- More than one household, or a household whose name is blank → the same machine fallback,
  with `setup=0`: no single name is *the* household's name.
- **The database could not be asked** → the machine fallback and `setup=0`. This is the
  case worth being careful about: `setup=1` sends someone to a wizard, and a busy psql is
  not a reason to send them back to one they already finished. `setup=1` is only ever
  advertised on a positive read of an empty install.

The name is computed at start and then re-checked once a minute until a household is
genuinely **on the network** under the name it will keep — the one transition a person
watches happen, since creating a household changes the name and the flag together. That
includes the awkward first-boot cases: a census psql was too busy to answer, and a
registration that failed to exec, are both states that can still change, so both keep
polling. Polling stops for good once one household has been advertised, so a settled
install pays nothing at all.

**The limitation that leaves:** renaming a household later does not change what is
advertised until the next restart. That is deliberate — a rename is rare, a restart fixes
it, and the alternative is a psql fork every minute forever on every install.

There is still no `waffled.local`: devices resolve this Mac by **its own** hostname
(`kevins-mac-mini.local`), which is exactly why discovery exists.

### Where to look when it does not work

`status` reports what this Mac *asked for*. Whether the rest of the house can see it is a
different question, so `doctor` browses for our own registration and, when it does not
answer, names the two things that are almost always responsible: the firewall, and (on
Sonoma and later) the Local Network privacy permission.

`doctor` browses with `dns-sd -t <seconds>` rather than killing the command on a deadline.
That is load-bearing, not tidiness: dns-sd block-buffers its stdout down a pipe, so a
browse that ends by being killed comes back empty and would report an empty network on a
Mac that is advertising perfectly well. If dns-sd ignores its own deadline and the context
does have to kill it, that is reported as a browse that **did not finish** — an empty
result nobody heard is not evidence about the firewall.

A registration that mDNSResponder renamed on a collision (`The Seinfelds (2)`, because a
neighbour advertised first) still counts as ours. Nothing else does: the match is the name
exactly, or the name followed by `" ("`, so a neighbour's `Smith Family` is not read as the
household `Smith` — a stranger's advertisement counted as ours would turn a registration
the firewall is blocking into a clean bill of health.

## The bundle contract

The runtime refuses to execute anything until the bundle matches its `manifest.json`:
set equality on files **and symlinks**, sha256 per file, the owner-exec bit, and
`arch`/`platform` against this machine. **This binary is one of the files it checks** —
`infra/native/bundle/build.sh` compiles it into `bin/waffled-runtime` before writing the
manifest, so the supervisor verifies itself along with everything it is about to run, and a
hand-built binary dropped into `bin/` afterwards is refused as a changed or extra file. It is a port of `manifest.mjs verify` from
`infra/native/bundle/` (branch `native-bundle`), whose README is the interface this
implements.

Symlinks are recorded and **never followed** — `bin/postgres/lib` has 17 relative links
without which `postgres` dies at dyld time, and PowerSync's `node_modules` is a 1,321-link
pnpm farm.

Verifying the real bundle (36,478 files, 1,338 symlinks, 587 MB) takes ~1.5s, so the
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
  "initialized": true,           // false until initdb has created the cluster
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

`initialized` says whether the **data directory** has ever been set up — it is a `stat` of
`postgres/PG_VERSION`, so it is answered with the whole stack down, which is exactly when
it is asked. The menu-bar app shows its first-run window on `false` and nothing on `true`;
it is reported here rather than worked out there because the runtime owns its layout, and
an app that stat'd PGDATA would be a second place that knows where the cluster lives.
`schema` stays at **1**: additive, and no existing field changed meaning.

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

So is the `bonjour` block:

```jsonc
"bonjour": {
  "advertised": true,
  "name": "The Seinfelds",         // "" while nothing is on the network
  "service": "_waffled._tcp",      // constant, reported even when stopped
  "port": 8080,                    // the public Caddy port
  "host": "kevins-mac-mini.local",
  "error": ""                      // why nothing is advertised, when something went wrong
}
```

`schema` stays at **1** for this one too. Nothing here feeds `state`: `advertised: false`
is never on its own a reason to draw a red icon.

`status` usually runs in a **different process** from the supervisor, so the advertisement
is recorded in `bonjour.json` beside `runtime.json`, written atomically. The file records
what was **asked for**; whether it is on the network is the advertiser's **pidfile's**
answer, and the two are combined here. (No supervisor pid is recorded: the process that
decides the second question is dns-sd's, and it outlives the supervisor.) They can
disagree: dns-sd runs in its own process group and outlives a SIGKILLed supervisor, so the
name and port are reported for an orphan that is still publishing, and a file left behind
with no advertiser running names nothing (but still carries the recorded reason, which is
why the unclean stop left it there).

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
If any are, it dumps to `backups/pre-migrate-<from>-to-<to>-<stamp>.dump` first — both
versions, because a snapshot marks a *crossing* and the question anyone asks of one is
which way it was going. `to` is the running build; `from` is the version `runtime.json`
recorded on the last successful start, or `unknown` on data written before that was kept.
The sidecar carries the same pair as `fromVersion`/`toVersion`, so a program never has to
split a filename on dashes that also appear inside version numbers. Names written by
earlier builds still parse: the timestamp is the last two dash-separated fields and
everything before it is prose.

One rough edge, recorded rather than papered over: a **retried** update names its snapshot
`<new>-to-<new>`. The first attempt migrated and failed, so it never recorded a version,
while the successful start before it did — so the second attempt's "from" is already the
new build. Two failed updates in a row therefore leave several same-looking names, and it
is their timestamps and sidecars, not their names, that put the story back in order.

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

**A refused start prunes nothing.** Retention lives inside `snapshotBeforeMigrate` and
`Backup`, both of which are downstream of the downgrade guard, so a start that refuses
leaves `backups/` exactly as it found it. That is not incidental: the file the refusal
recommends is in that directory, and a guard that pruned on its way out could delete the
one thing it just told someone to restore.

There is **one** snapshot per schema change, not two. An earlier draft of the plan
reserved a second retention prefix for the updater, on the assumption that swapping
binaries and changing the schema were separate events that should not evict each other's
rollback points. With the one-unit decision below they are the same event — a `start` from
a newer bundle — so `pre-migrate-` is the only snapshot pool there is.

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

## Updates

**The Mac app is one unit, Plex-style.** Sparkle swaps the whole `Waffled.app` — with this
runtime bundle inside it — relaunches, and the menu-bar app runs `waffled-runtime start`
from the *new* bundle against the *existing* data directory. **A `start` from a newer
bundle IS the update.** There is no binary-swap step for the runtime to perform, no
`update` subcommand, and no second copy of the old bundle on disk to fall back to.

So "rollback" has two halves, and only one of them is ours:

| | who does it | how |
|---|---|---|
| the **data** | the runtime | snapshot → migrate → api health gate → restore the snapshot and refuse to come up |
| the **availability** | a person | re-install the previous DMG, which must then start cleanly on the restored data |

**What a failed update looks like.** The new build starts, sees migrations pending, dumps
`pre-migrate-<old>-to-<new>-<stamp>.dump`, migrates, and the api fails its health gate.
The database is restored from that snapshot and `start` exits with an error naming the
file. Nothing is left running. The household is exactly where they were, on a schema their
*previous* build can serve — which is what makes the second half work at all.

**Going back.** Re-installing the previous version and starting is supported and tested:
the older bundle finds nothing pending, takes no snapshot, and comes up on the restored
data with PowerSync's storage and replication slot rebuilt. What it must never do is open
a database a *newer* build already migrated, which is the state after an update that
succeeded, or one that failed somewhere the automatic restore could not reach.

### The downgrade guard

`start` compares `pgmigrations` against the migrations the bundle ships and **refuses**
when the database holds any this build does not — after Postgres is up, before migrate and
the api. Migrations only run forward: there is no way to bring a schema back down, and an
api serving tables and columns its code does not know about fails silently rather than
loudly. `doctor` reports the same condition as a **FAIL**, starting Postgres for itself the
way `backup` does — a refused start leaves nothing running, so a check that needed a live
server would be dead code in the one case it exists for.

That postmaster is started **once**, above all of `doctor`'s database checks, and serves
the schema comparison, `pg_isready`, `wal_level` and the collation check together. The
alternative it replaces was worse than untidy: the schema check booted Postgres for itself
and shut it down, and the "postgres is running" gate below it then stopped the rest — so
the command someone runs *because* their server will not start answered fewer questions
than the one they run when it is fine, having paid for the boot either way. `doctor` still
leaves the machine as it found it: the temporary postmaster is stopped on the way out, and
the report says plainly when it was one.

The refusal names both versions, the migrations this build lacks, and the newest snapshot
in `backups/` that **this** build could actually restore (checked with the same
`CheckRestorable` `restore` uses, so it can never recommend a file that would then be
refused), and then the two ways out: re-install the newer version, or
`waffled-runtime restore <that file> --yes`.

It **does not auto-restore**. Everything the newer version wrote is still on disk, and
restoring is the one action here that discards it — that is a person's decision, not a
guard's, running at startup on a Mac nobody is sitting at.

Two cases it keeps apart. Migrations *above* this build's newest are evidence of a newer
Waffled. Migrations *below* it are not — this repo has renumbered before (0084→0086) — so
that case refuses with its own wording rather than sending someone after a download that
does not exist. And a version is never described as newer than itself: the newer build can
migrate and then fail before it goes green, so it never records itself in `runtime.json`.

### What `runtime.json` and `status` remember

`bundleVersion` is the version the data was last **started** with, written only once a
start has gone green. The timing is the whole point: recording the new version on the way
in would overwrite the only record of what wrote the data with the thing about to change
it, and a start that fails must leave that record intact. It is the `from` half of a
snapshot's name and of the guard's message.

A start that finds a different version than the file remembered also writes
`previousBundleVersion` and `bundleVersionChangedAt`, which surface additively in
`status --json` as `bundle.version`, `bundle.previousVersion` and
`bundle.versionChangedAt`. They come from the file rather than from the process that did
the changing, because `status` is a separate command run seconds later.

Every one of those names is **direction-neutral**, and that is the point. A crossing is
two endpoints and a moment; it has no direction of its own. Re-installing an **older**
build is the documented recovery from the downgrade guard, so a rollback is exactly as
ordinary as an update here, and a field called `updatedAt` invites a reader to assume
otherwise — which is how `status` came to greet that recovery with "updated from 0.15.0".

Which way it went is **derived** from the two versions, by comparing the `MAJOR.MINOR.PATCH`
prefix numerically (`+build` metadata is ignored: it says which build, never which is
newer). `status` prints one of three lines, and anything rendering these fields should make
the same comparison rather than assume:

| what happened | the line |
|---|---|
| the new version sorts **after** the old | `updated from 0.14.3 on 2026-09-08T03:00:00Z` |
| the new version sorts **before** the old | `rolled back from 0.15.0 on 2026-09-08T03:00:00Z` |
| the two cannot be ordered — a dev build, a pre-release, or the same version rebuilt | `changed from main-abc1234 on 2026-09-08T03:00:00Z` |

Data that has only ever known one version has no crossing and gets no line at all.

## Uninstalling

```sh
waffled-runtime uninstall                 # remove the runtime's traces, KEEP the data
waffled-runtime uninstall --dry-run       # print the plan, change nothing
waffled-runtime uninstall --delete-data   # …and delete the data directory too
waffled-runtime uninstall --json          # schema 1, for the Mac app
waffled-runtime uninstall --yes           # stop the server first if it is still running
```

**Keeping the household's data is the default, and nothing is ever deleted silently.**
Every run — dry or real — prints the whole inventory with `kept` against what survives
and its size, so a person reading the output knows exactly what is still on disk. Plan §5
says never auto-delete; this is that, made explicit.

`uninstall` refuses while a server is running and names the pid, unless `--yes`, which
runs the ordinary stop first and says that it did. `--dry-run` is the exception: it
reports a running server rather than refusing over it, because "is it safe to uninstall
yet" is exactly what a dry run is for. It is idempotent — a second run reports every item
`present: false` and exits 0 — and it exits non-zero only on a real failure.

It does **not** build a Supervisor, and that is load-bearing: constructing one writes to
the directory being inventoried (creates the layout, writes `config.env` with fresh
secrets, `runtime.json`, `bundle-verified.json`, sets the Time Machine xattr). Routed
through that, `--dry-run` would change what it promised not to and a second run would
find a data directory it had just recreated.

### What is removed, and what is kept

The two halves add up to a complete uninstall. This command owns the machine-level half;
the Mac app's **Remove Waffled…** owns its own.

| | Where | Uninstall does what | Who |
|---|---|---|---|
| nightly backup schedule | `~/Library/LaunchAgents/app.waffled.backup.plist`, and the loaded launchd job | **removed** — booted out of `gui/$UID`, then the plist deleted. Only when it is really installed *and* its plist names this `--data` directory: the launchd label is global, so one Mac holds one nightly backup and booting out another data directory's would stop a household's real backups. A plist that cannot be read is **kept**, not guessed at — remove it explicitly with `backup --uninstall-schedule` | `uninstall` |
| pidfiles | `<data>/pids/` | **removed**, and anything still alive in there is SIGTERM'd first — a service orphaned by a crash is the whole "nothing dead left behind" case | `uninstall` |
| Bonjour registration | `<data>/bonjour.json`, `<data>/pids/bonjour.pid`, and the `dns-sd` process holding the advertisement | **removed** — killing `dns-sd` *is* the deregistration, because mDNSResponder drops a registration when the client that made it goes away | `uninstall` |
| Postgres socket directory | a `wfl*` temp directory, only when the data path was too long for a unix socket | **removed** — it is outside the data root, so nothing in the data folder's own cleanup reaches it. Kept, with the reason, if it holds anything that is not a `.s.PGSQL*` socket or cannot be read: the path comes out of `runtime.json`, which a person can edit | `uninstall` |
| the data directory | `~/Library/Application Support/Waffled` — the Postgres cluster, media, backups, logs, secrets, `runtime.json`, PowerSync's `.probes/`, Caddy's state, and the Time Machine exclusion xattr on `postgres/` (which goes with the folder) | **kept**, with its path and size printed. `--delete-data` removes it instead | `uninstall --delete-data` |
| the login item | registered with `SMAppService.mainApp` — no helper, no plist to find | removed | the Mac app |
| app preferences | `~/Library/Preferences/app.waffled.mac.plist` | removed | the Mac app |
| Sparkle's update caches | `~/Library/Caches/app.waffled.mac/` | removed | the Mac app |
| `Waffled.app` itself | `/Applications` | dragged to the Trash | you, or the Mac app |

⚠️ **`--delete-data` is unrecoverable.** It takes `config.env` with it, and the secrets in
there — `LOCAL_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `POWERSYNC_JWT_PRIVATE_KEY`, any
Google OAuth client secret you added — exist nowhere else. Take a backup first
(`waffled-runtime backup --out ~/Desktop/waffled.dump`) and copy `config.env` somewhere
safe if you might ever come back.

### `uninstall --json`

Schema 1. `action` is what this run does, `present` is what it found — so a first run is
all `present: true` and a second all `present: false`. `dryRun` says whether the document
is a plan or a receipt: without it the two are shape-identical. An item that could not be removed
carries an `error`, and the text output prints it as `failed` rather than `removed`: the
document is emitted even when the command exits non-zero, because "refused, nothing
changed" and "half removed" are exactly what a caller has to tell apart. The one
exception is the refusal itself — it happens before anything is attempted, so there is no
outcome to report and it is a stderr message and exit 1 with no document.

```jsonc
{
  "schema": 1,
  "dryRun": false,               // true when nothing was done — a plan, not a receipt
  "dataDir": "/Users/…/Application Support/Waffled",
  "dataSizeBytes": 3900080,
  "items": [
    { "kind": "schedule", "path": "/Users/…/LaunchAgents/app.waffled.backup.plist",
      "sizeBytes": 9, "action": "remove", "present": true,
      "detail": "the nightly backup launchd agent" },
    { "kind": "bonjour",  "path": "/Users/…/Waffled/bonjour.json",
      "sizeBytes": 3, "action": "remove", "present": true, "detail": "…" },
    { "kind": "pidfiles", "path": "/Users/…/Waffled/pids",
      "sizeBytes": 5, "action": "remove", "present": true, "detail": "…" },
    { "kind": "socket",   "path": "/var/folders/…/wflPMyR",
      "sizeBytes": 0, "action": "remove", "present": true, "detail": "…" },
    { "kind": "data",     "path": "/Users/…/Application Support/Waffled",
      "sizeBytes": 3900080, "action": "keep", "present": true,
      "detail": "your household's database, photos, backups and config.env" }
  ]
}
```

`dataSizeBytes` is a `filepath.WalkDir` over the data root that **does not follow
symlinks** — a link into somebody's Photos library is not the household's own data, and a
link back inside the root would be counted twice. That walk lives in this command and
nowhere else: `status` is polled by the menu bar and must stay cheap (`apps/mac/CLAUDE.md`).

### When the app is already in the Trash

The binary ships *inside* the app bundle, so once `Waffled.app` is gone there is nothing
left to run `uninstall` with. Undo it in Finder and run the command, or do the same
things by hand:

```sh
launchctl bootout "gui/$UID/app.waffled.backup" 2>/dev/null   # stop the nightly backup
rm -f ~/Library/LaunchAgents/app.waffled.backup.plist         # …and its job file
rm -rf ~/Library/Application\ Support/Waffled                 # ← your data. Back it up first.
defaults delete app.waffled.mac 2>/dev/null                   # the app's own preferences
rm -rf ~/Library/Caches/app.waffled.mac                       # Sparkle's update caches
```

If `runtime.json` recorded a `wfl*` socket directory under `/var/folders`, delete that too
— read the path out of the file before you remove the data folder. Nothing in the steps
above reaches it; macOS does eventually clear `/var/folders` itself, but not on any
schedule worth waiting for.

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
supervision, log rotation, the status contract, the Bonjour advertisement (which name
wins, what `setup` means, the TXT keys and their byte limits, and the argv handed to
dns-sd), and the uninstall inventory (a dry run that leaves the tree byte-identical, the
data root surviving without `--delete-data`, the refusal while a supervisor is running,
and a second run that is a no-op).

The uninstall tests never use a real `schedule.Agent`: `Uninstall` boots out a launchd
*label*, so pointing one at a temp `AgentsDir` would still unload the nightly backup of
whoever runs the suite. They inject a fake through the `ScheduleAgent` interface, and the
command's own test points `HOME` at a temp directory.

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
- `TestTheStackAdvertisesItselfOnBonjour` — reads the advertisement back off the network
  with `dns-sd -Z`: the six TXT keys, `setup=1` on an install with no household, the url
  and port pointing at the public port, and the instance gone again after `stop`. It
  matches the instance by **port**, never by name: the Mac running the test may already be
  running a real Waffled, and mDNSResponder renames a colliding instance rather than
  refusing it. The network assertions skip with a clear message where multicast or
  mDNSResponder is unavailable (CI runners); the child lifecycle is asserted regardless.
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
- `TestUpdateAcrossTwoBundleVersions` (also `internal/supervisor`) is the only test that
  runs **two** bundles against one data directory, which is the only way to reach the
  things that exist between versions: A → a canary row → B (the update) → B with a forced
  api-gate failure (the rollback) → **A again**, the re-install path, on the restored data
  → B → A refused by the downgrade guard. It asserts one snapshot per schema change, named
  and sidecar'd for the crossing and taken *before* the migration; `status` reporting the
  new version and the old one as previous, read through a **fresh** supervisor because the
  menu-bar app is a separate process; and a refusal that names a file which exists and
  which `CheckRestorable` agrees the older build could serve. Bundle B is the real bundle
  APFS-cloned (`cp -c`, ~7s) with its version bumped, one leaf-table migration added and
  its manifest re-scanned. The whole loop takes **about 55s**.
- `TestStartRefusesADatabaseMigratedByANewerBuild` (there too, for the unexported helpers)
  is the guard on its own, at the cost of one start: a single `pgmigrations` row is all a
  newer build would leave behind, and it is what the guard reads. It also asserts `doctor`
  reports the same thing with the stack **down**, answers its other Postgres checks
  (`pg_isready`, `wal_level`, collation) in the same breath rather than skipping them, and
  puts Postgres back afterwards.
- `TestTheAdvertisementFollowsSetupBeingFinished` lives there for the same kind of reason:
  watching `setup=1` flip to the household's own name in seconds rather than a minute means
  shortening `bonjourSetupPoll`, which is unexported and never written in production.

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

## CI

`.github/workflows/native-runtime.yml` runs on every PR/push touching `apps/runtime/**`,
`apps/mac/**`, `infra/native/bundle/**` or `infra/compose/**`:

- `runtime-go` (ubuntu-latest): `gofmt -l`, `go vet ./...`, `go test ./...` — the unit suite
  above, no bundle. Fast, fails fast.
- `runtime-macos` (macos-15, Apple silicon): `infra/native/bundle/build.sh fetch|build|verify`
  assembles the real bundle (`WAFFLED_BUNDLE_CACHE` cached across runs, keyed on the pins in
  `build.sh`), then `go build ./cmd/waffled-runtime` and
  `WAFFLED_BUNDLE=<outdir> go test -tags integration -p 1 ./...` — the same integration suite
  above, boot-testing the stack from an empty data dir on free ports. This is the Phase 2 exit
  criterion's automated check (`docs/product/native-mac-plan.md` §7). The same job then builds
  `Waffled.app` around that bundle (`apps/mac/Scripts/build-app.sh`) and boots the assembled
  app with **no dev-mode environment variables**, which is where this binary gets exercised the
  way a household will actually run it: found by path inside the app, resolving its own
  `--bundle`, verifying it, and bringing the stack up — twice. Once from an empty data
  directory, where the app holds its one auto-start for the welcome window and the CLI's own
  `start` does the setup a person's click would; and once on that set-up directory, which the
  app auto-starts by itself.

## Not this task

The updater's **data** half is done — see [Updates](#updates): the snapshot, the migration,
the health gate, the automatic restore and the downgrade guard, proven across two real
bundle versions. There is no `update` subcommand and there should not be one: a `start`
from a newer bundle already is the update, and a subcommand would have to know about DMGs
and app bundles, which is the other half's job.

What remains is that other half, in Phase 3: **Sparkle** — the appcast, the signed DMG,
swapping `Waffled.app` and relaunching. None of it is the runtime's; the runtime's part is
to be started afterwards and do the right thing, which is what it now does.

## Portability

Standard library only — no third-party dependencies, no cgo. macOS-specific behaviour
(the default data directory, the Time Machine exclusion, the dns-sd client) sits behind
`//go:build darwin` with a no-op sibling. `GOOS=linux go build ./...` is clean; the Windows
work parked in plan §9 additionally needs equivalents for three POSIX calls the supervisor
uses today (`Flock` for the backup lock, `Setsid`/`Setpgid` for process groups, and
`Statfs` for free space), so the build tags here are a start on that and not the whole of
it. `internal/bonjour`'s non-darwin `Tool()` returns `""` and the
supervisor then skips advertising and says so in `status` — never an error, because a
server no phone can discover still serves everything that has its address. Windows has
`dns-sd.exe` only where Bonjour for Windows is installed and Linux would register through
Avahi; both are later decisions, and that file is the seam.
