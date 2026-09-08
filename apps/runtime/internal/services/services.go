// Package services describes how each of the five services is launched: argv,
// environment, working directory, and where its health is checked.
//
// It is deliberately pure — a Plan produces Specs and config file bodies and starts
// nothing. That keeps the part that is easy to get subtly wrong (which port goes in
// which variable; loopback vs public; production vs not) under fast unit tests, and
// leaves internal/supervisor to worry about processes.
//
// Every value here traces to infra/compose/docker-compose.yml. Where the two differ it
// is because the compose network does not exist natively: hostnames become 127.0.0.1
// with a chosen port, and the api/PowerSync/Postgres bind loopback only.
package services

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/kevinpsites/waffled/apps/runtime/internal/caddyconf"
	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
)

// Service names, used for log files, pidfiles and status output.
const (
	Postgres  = "postgres"
	Migrate   = "migrate"
	API       = "api"
	PowerSync = "powersync"
	Caddy     = "caddy"
)

// Order is the dependency order Compose expresses with depends_on + healthchecks.
// Stopping walks it backwards.
var Order = []string{Postgres, API, PowerSync, Caddy}

// StorageDatabase is PowerSync's own bucket-storage database, created by 00-init.sql.
const StorageDatabase = "powersync_storage"

// Spec is one launchable command.
type Spec struct {
	Name string
	Path string
	Args []string
	Env  []string
	Dir  string
	// HealthURL is polled until it answers 2xx. Empty means "no HTTP gate".
	HealthURL string
	// OneShot commands run to completion and must exit 0 (migrate, psql, initdb).
	OneShot bool
	// Port is the port this service listens on, and Scope the address it binds. Zero
	// and Loopback for a one-shot, which listens on nothing. Carrying them here is what
	// lets status report a service's port without switching on its name — a switch a
	// new service is easy to forget, and then it shows as Port 0 to the menu-bar app.
	Port  int
	Scope ports.Scope
}

// PortCheck is one port the stack needs: who binds it, on which address, and what to
// call it when telling a person about it.
//
// This table used to exist twice — hand-copied into the supervisor's settlePorts and
// into doctor, already differing in its labels — so adding a service, or a second Caddy
// site, meant remembering both. One list now feeds both, and a port doctor reports free
// can no longer be one start refuses.
type PortCheck struct {
	// Service is the managed service that binds it, so the caller can ask "is this one
	// of ours already running?" rather than treating our own port as a conflict.
	Service string
	// Label names the port for a person. Caddy binds two, so the service name alone
	// would not distinguish them.
	Label string
	Scope ports.Scope
	Port  int
}

// PortChecks is every port the stack listens on, in start order.
func (p Plan) PortChecks() []PortCheck {
	return []PortCheck{
		{Service: Caddy, Label: "public HTTP", Scope: ports.Public, Port: p.Ports.Public},
		{Service: Caddy, Label: "public PowerSync", Scope: ports.Public, Port: p.Ports.PowerSyncPublic},
		{Service: API, Label: "api", Scope: ports.Loopback, Port: p.Ports.API},
		{Service: PowerSync, Label: "powersync", Scope: ports.Loopback, Port: p.Ports.PowerSync},
		{Service: Postgres, Label: "postgres", Scope: ports.Loopback, Port: p.Ports.Postgres},
	}
}

// Children are the long-running services the supervisor watches, in dependency order.
// Start walks it forwards (with the config staging each one needs in between) and Stop
// walks it backwards.
//
// Postgres is deliberately not here. pg_ctl exits as soon as the postmaster is
// accepting connections, so watching it as a child would read a successful start as an
// immediate crash and restart-loop forever; it is driven through pg_ctl instead.
func (p Plan) Children() []Spec {
	return []Spec{p.API(), p.PowerSync(), p.Caddy()}
}

// Plan holds everything the specs are derived from.
type Plan struct {
	Bundle    string
	Layout    datadir.Layout
	Env       *configenv.Env
	Manifest  *manifest.Manifest
	Ports     rtstate.Ports
	SocketDir string
}

// baseEnv is the environment every child starts from. Building it from scratch rather
// than inheriting matters: the operator's shell may export DATABASE_URL, NODE_ENV or
// PG* variables that would silently outrank ours. The bundle's own verify runs every
// entry point under `env -i PATH=/usr/bin:/bin`, so a clean environment is proven.
//
// HOME points at the data directory so nothing a child does can scatter state through
// the user's home; TMPDIR is passed because Node and Postgres both need one.
func (p Plan) baseEnv() []string {
	return []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + p.Layout.Root,
		"TMPDIR=" + os.TempDir(),
		"LANG=en_US.UTF-8",
	}
}

func (p Plan) node() string { return filepath.Join(p.Bundle, "bin", "node") }

// PostgresBin resolves a Postgres executable inside the bundle. The binaries find their
// own lib/ and share/ through @loader_path, so no DYLD_* or PGSHAREDIR is needed as long
// as bin/, lib/ and share/ stay siblings.
func (p Plan) PostgresBin(name string) string {
	return filepath.Join(p.Bundle, "bin", "postgres", "bin", name)
}

func (p Plan) databaseURL() string {
	return p.Env.DatabaseURL(p.Ports.Postgres, p.Env.PostgresDB())
}

func (p Plan) storageURL() string {
	return p.Env.DatabaseURL(p.Ports.Postgres, StorageDatabase)
}

// API mirrors the compose `api` service. HOST is set even though the api only honours it
// once the HOST change lands (PR #177) — setting it now means the day it merges, the
// api is on loopback with no runtime change.
func (p Plan) API() Spec {
	env := append(p.baseEnv(),
		"NODE_ENV=production",
		"HOST=127.0.0.1",
		"PORT="+strconv.Itoa(p.Ports.API),
		"DATABASE_URL="+p.databaseURL(),
		"LOCAL_JWT_SECRET="+p.Env.Get(configenv.KeyLocalJWTSecret),
		"TOKEN_ENCRYPTION_KEY="+p.Env.Get(configenv.KeyTokenEncryptionKey),
		"POWERSYNC_JWT_PRIVATE_KEY="+p.Env.Get(configenv.KeyPowerSyncJWTPrivateKey),
		"STORAGE_DRIVER=local",
		"MEDIA_DIR="+p.Layout.Media,
		"MEDIA_BASE_URL=/media",
		// Left empty on purpose: the api then derives the sync URL from the address each
		// device actually used, so a phone and the kiosk each get one they can reach.
		"POWERSYNC_PUBLIC_URL=",
		// The PUBLIC PowerSync port — Caddy's, not the loopback one.
		"POWERSYNC_PORT="+strconv.Itoa(p.Ports.PowerSyncPublic),
		"LOG_FORMAT=json",
		"LOG_LEVEL=info",
		// No backup sidecar and no update notifier natively: the Mac app owns both.
		"BACKUP_ENABLED=false",
		"UPDATE_CHECK_ENABLED=false",
	)
	env = append(env, p.provenance()...)
	// Anything the operator added to config.env by hand — an AI key, Google OAuth — is
	// passed through so the native install is as capable as the Docker one.
	env = append(env, p.passthrough()...)

	return Spec{
		Name:      API,
		Path:      p.node(),
		Args:      []string{p.node(), filepath.Join(p.Bundle, p.apiServe())},
		Env:       env,
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/healthz", p.Ports.API),
		Port:      p.Ports.API,
		Scope:     ports.Loopback,
	}
}

// Migrate is the one-shot that replaces compose's `migrate` container. It runs the
// bundle's own dist/migrate.js, which resolves the .sql files at ../migrations relative
// to itself — the reason api/dist stays a directory in the bundle.
func (p Plan) Migrate() Spec {
	env := append(p.baseEnv(),
		"NODE_ENV=production",
		"DATABASE_URL="+p.databaseURL(),
		"LOCAL_JWT_SECRET="+p.Env.Get(configenv.KeyLocalJWTSecret),
		"TOKEN_ENCRYPTION_KEY="+p.Env.Get(configenv.KeyTokenEncryptionKey),
		"POWERSYNC_JWT_PRIVATE_KEY="+p.Env.Get(configenv.KeyPowerSyncJWTPrivateKey),
	)
	return Spec{
		Name:    Migrate,
		Path:    p.node(),
		Args:    []string{p.node(), filepath.Join(p.Bundle, p.apiMigrate())},
		Env:     env,
		OneShot: true,
	}
}

// PowerSync mirrors the compose `powersync` service. Its cwd is in the data directory
// because it creates a .probes/ folder there and the bundle is read-only once signed.
func (p Plan) PowerSync() Spec {
	env := append(p.baseEnv(),
		"POWERSYNC_CONFIG_PATH="+filepath.Join(p.Layout.PowerSync, "service.yaml"),
		"PS_PORT="+strconv.Itoa(p.Ports.PowerSync),
		"PS_DATA_SOURCE_URI="+p.databaseURL(),
		"PS_STORAGE_SOURCE_URI="+p.storageURL(),
		fmt.Sprintf("PS_JWKS_URL=http://127.0.0.1:%d/api/auth/keys", p.Ports.API),
	)
	return Spec{
		Name: PowerSync,
		Path: p.node(),
		Args: []string{
			p.node(), "--max-old-space-size=1000",
			filepath.Join(p.Bundle, p.powersyncEntry()),
			"start", "-r", "unified",
		},
		Env:       env,
		Dir:       p.Layout.PowerSync,
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/probes/liveness", p.Ports.PowerSync),
		Port:      p.Ports.PowerSync,
		Scope:     ports.Loopback,
	}
}

// Caddy is the only service on the wildcard address — the native equivalent of the
// compose port publications.
func (p Plan) Caddy() Spec {
	caddy := filepath.Join(p.Bundle, "bin", "caddy")
	env := append(p.baseEnv(),
		"CADDY_SITE_ADDRESS="+caddyconf.SiteAddress(p.Ports.Public),
		"POWERSYNC_CADDY_ADDRESS="+caddyconf.SiteAddress(p.Ports.PowerSyncPublic),
		// Keep autosave.json and the local CA inside the data directory.
		"XDG_DATA_HOME="+p.Layout.Caddy,
		"XDG_CONFIG_HOME="+p.Layout.Caddy,
	)
	return Spec{
		Name: Caddy,
		Path: caddy,
		Args: []string{
			caddy, "run",
			"--config", p.Layout.CaddyfilePath,
			"--adapter", "caddyfile",
		},
		Env: env,
		Dir: p.Layout.Caddy,
		// Status only; the body is the SPA (a pre-existing quirk of the shared Caddyfile).
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/healthz", p.Ports.Public),
		// Caddy binds two public ports; Port is the one status reports. Both are in
		// PortChecks, which is what start and doctor validate against.
		Port:  p.Ports.Public,
		Scope: ports.Public,
	}
}

// InitdbArgs creates the cluster. The superuser is POSTGRES_USER and scram is on from
// the first byte, exactly as the postgres:16 image does it.
//
// The locale is en_US.UTF-8, NOT the C locale: the Docker image initializes clusters as
// en_US.utf8, and a family migrating from Docker to the Mac app by restoring a dump must
// keep the same text collation. A different collation silently changes sort order and
// makes every index report a collation-version mismatch.
func (p Plan) InitdbArgs(pwfile string) []string {
	return []string{
		"-D", p.Layout.Postgres,
		"-U", p.Env.PostgresUser(),
		"--pwfile=" + pwfile,
		"--auth=scram-sha-256",
		"--encoding=UTF8",
		"--locale=en_US.UTF-8",
	}
}

// InitdbCollation is what the created databases must report for datcollate/datctype.
// Postgres normalizes the spelling, so callers compare case-insensitively without the
// separator: "en_US.UTF-8" and "en_US.utf8" are the same locale.
const InitdbCollation = "en_US.UTF-8"

// PostgresConf is appended to the generated postgresql.conf: everything compose passes
// on the `postgres` command line, plus loopback confinement.
func (p Plan) PostgresConf() string {
	return fmt.Sprintf(`
# ── waffled-runtime ─────────────────────────────────────────────────────────
# Managed by waffled-runtime. Values above this block are initdb's defaults.
listen_addresses = '127.0.0.1'
port = %d
unix_socket_directories = '%s'
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
password_encryption = scram-sha-256
log_line_prefix = '%%m [%%p] '
`, p.Ports.Postgres, p.SocketDir)
}

// PostgresHBA is loopback-only scram. Never `trust`: natively there is no container
// boundary, so every process on the Mac can reach this port.
func (p Plan) PostgresHBA() string {
	return `# Managed by waffled-runtime. Loopback only, scram everywhere — natively there is no
# container network to hide behind, so the password is the boundary.
# TYPE  DATABASE     USER  ADDRESS        METHOD
local   all          all                  scram-sha-256
host    all          all   127.0.0.1/32   scram-sha-256
host    all          all   ::1/128        scram-sha-256
# PowerSync opens a logical replication slot over the same loopback connection.
host    replication  all   127.0.0.1/32   scram-sha-256
host    replication  all   ::1/128        scram-sha-256
`
}

// psqlSpec is a psql invocation against database, with verb supplying whatever says
// what to run. The password travels in PGPASSWORD rather than inside a postgres:// URL
// in argv, which every process on the Mac can read from `ps`.
//
// Both forms go through here so that neither can be built by slicing the other apart.
// PsqlCommand used to take Psql's args and drop the last two to remove a placeholder
// `-f ""` — which meant appending any flag to Psql would silently hand psql an empty -f
// alongside -tAc, and break every caller of PsqlCommand at runtime with no compile error.
func (p Plan) psqlSpec(database string, verb ...string) Spec {
	psql := p.PostgresBin("psql")
	args := []string{
		psql,
		"-h", "127.0.0.1",
		"-p", strconv.Itoa(p.Ports.Postgres),
		"-U", p.Env.PostgresUser(),
		"-d", database,
		"-v", "ON_ERROR_STOP=1",
		"--no-psqlrc",
	}
	return Spec{
		Name:    "psql",
		Path:    psql,
		Args:    append(args, verb...),
		Env:     append(p.baseEnv(), "PGPASSWORD="+p.Env.Get(configenv.KeyPostgresPassword)),
		OneShot: true,
	}
}

// Psql runs a SQL file as the superuser.
func (p Plan) Psql(database, file string) Spec {
	return p.psqlSpec(database, "-f", file)
}

// PsqlCommand is Psql for a single statement, returned unaligned and untitled so the
// caller can read the value straight out of stdout.
func (p Plan) PsqlCommand(database, sql string) Spec {
	return p.psqlSpec(database, "-tAc", sql)
}

// PgIsReady is the health gate for Postgres — the same check compose's healthcheck runs.
func (p Plan) PgIsReady() Spec {
	bin := p.PostgresBin("pg_isready")
	return Spec{
		Name: "pg_isready",
		Path: bin,
		Args: []string{
			bin,
			"-h", "127.0.0.1",
			"-p", strconv.Itoa(p.Ports.Postgres),
			"-U", p.Env.PostgresUser(),
			"-d", p.Env.PostgresDB(),
		},
		Env:     p.baseEnv(),
		OneShot: true,
	}
}

// PgCtl builds a pg_ctl invocation. Postgres is started and stopped through pg_ctl
// rather than supervised as a child: pg_ctl exits as soon as the postmaster is up, so a
// child-watcher would read that exit as a crash and restart-loop forever.
func (p Plan) PgCtl(args ...string) Spec {
	bin := p.PostgresBin("pg_ctl")
	return Spec{
		Name:    "pg_ctl",
		Path:    bin,
		Args:    append([]string{bin, "-D", p.Layout.Postgres}, args...),
		Env:     p.baseEnv(),
		OneShot: true,
	}
}

// provenance surfaces the bundle's build identity on /healthz and System Health. Without
// it the api reports sha "dev" forever, because natively nothing sets these at build.
func (p Plan) provenance() []string {
	if p.Manifest == nil {
		return nil
	}
	return []string{
		"GIT_SHA=" + p.Manifest.GitSha,
		"BUILD_TIME=" + p.Manifest.BuiltAt,
	}
}

// passthroughKeys are optional settings an operator may add to config.env by hand. They
// are forwarded verbatim when present, and omitted entirely when not, so the api falls
// back to its own defaults rather than seeing an empty string.
var passthroughKeys = []string{
	"PUBLIC_BASE_URL",
	"ACCESS_TOKEN_TTL_SECONDS", "REFRESH_TOKEN_TTL_DAYS", "AUTH_FORCE_PASSWORD",
	"ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
	"OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
	"OLLAMA_HOST", "OLLAMA_MODEL",
	"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALENDAR_REDIRECT_URI", "GOOGLE_CALENDAR_SCOPES",
	"MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_CALENDAR_REDIRECT_URI", "MS_CALENDAR_SCOPES",
	"TZ",
}

func (p Plan) passthrough() []string {
	var out []string
	for _, key := range passthroughKeys {
		if v := p.Env.Get(key); v != "" {
			out = append(out, key+"="+v)
		}
	}
	return out
}

// The entry points come from the manifest rather than being hard-coded, so a bundle that
// moves a file says so in one place. The fallbacks are the documented layout.
func (p Plan) apiServe() string {
	if p.Manifest != nil && p.Manifest.Components.API.Serve != "" {
		return p.Manifest.Components.API.Serve
	}
	return "api/dist/server.js"
}

func (p Plan) apiMigrate() string {
	if p.Manifest != nil && p.Manifest.Components.API.Migrate != "" {
		return p.Manifest.Components.API.Migrate
	}
	return "api/dist/migrate.js"
}

func (p Plan) powersyncEntry() string {
	if p.Manifest != nil && p.Manifest.Components.PowerSync.Entry != "" {
		return p.Manifest.Components.PowerSync.Entry
	}
	return "powersync/service/lib/entry.js"
}
