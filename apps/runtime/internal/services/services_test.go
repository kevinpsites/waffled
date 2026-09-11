package services

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
)

func testPlan(t *testing.T) Plan {
	t.Helper()
	env, err := configenv.Load(filepath.Join(t.TempDir(), "config.env"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	return Plan{
		Bundle: "/Applications/Waffled.app/Contents/Resources/runtime",
		Layout: datadir.At("/Users/kev/Library/Application Support/Waffled"),
		Env:    env,
		Ports:  rtstate.Ports{Public: 8082, PowerSyncPublic: 8083, API: 3002, PowerSync: 8084, Postgres: 5434},
		Manifest: &manifest.Manifest{
			GitSha: "a506c352", BuiltAt: "2026-09-04T23:48:42.438Z", WaffledVersion: "0.14.3",
			Components: manifest.Components{
				Node:      manifest.Component{Version: "24.19.0", Path: "bin/node"},
				API:       manifest.Component{Serve: "api/dist/server.js", Migrate: "api/dist/migrate.js"},
				PowerSync: manifest.Component{Entry: "powersync/service/lib/entry.js"},
			},
		},
		SocketDir: "/Users/kev/Library/Application Support/Waffled/postgres",
	}
}

func envMap(pairs []string) map[string]string {
	out := map[string]string{}
	for _, p := range pairs {
		k, v, _ := strings.Cut(p, "=")
		out[k] = v
	}
	return out
}

// A child must never inherit the operator's shell. A stray DATABASE_URL or
// NODE_ENV=development in someone's ~/.zshrc would silently win over ours.
func TestChildEnvironmentIsBuiltFromScratch(t *testing.T) {
	p := testPlan(t)
	for _, spec := range []Spec{p.API(), p.PowerSync(), p.Caddy(), p.Migrate(), p.Admin(nil)} {
		e := envMap(spec.Env)
		if e["PATH"] != "/usr/bin:/bin" {
			t.Errorf("%s: PATH = %q, want a minimal one", spec.Name, e["PATH"])
		}
		if len(spec.Env) > 40 {
			t.Errorf("%s: %d environment variables looks like an inherited environment", spec.Name, len(spec.Env))
		}
	}
}

func TestAPIRunsTheBundledNodeInProductionOnLoopback(t *testing.T) {
	p := testPlan(t)
	spec := p.API()

	wantExe := filepath.Join(p.Bundle, "bin", "node")
	if spec.Path != wantExe {
		t.Errorf("api must run the bundled node, got %q", spec.Path)
	}
	if len(spec.Args) < 1 || spec.Args[len(spec.Args)-1] != filepath.Join(p.Bundle, "api", "dist", "server.js") {
		t.Errorf("api argv = %v", spec.Args)
	}

	e := envMap(spec.Env)
	// NODE_ENV=production is what makes the api enforce real secrets; without it the
	// bundle happily serves DB-free routes on :3000.
	if e["NODE_ENV"] != "production" {
		t.Errorf("NODE_ENV = %q, want production", e["NODE_ENV"])
	}
	if e["PORT"] != "3002" {
		t.Errorf("PORT = %q", e["PORT"])
	}
	if e["HOST"] != "127.0.0.1" {
		t.Errorf("HOST = %q, want 127.0.0.1", e["HOST"])
	}
	if e["DATABASE_URL"] != p.Env.DatabaseURL(5434, "waffled") {
		t.Errorf("DATABASE_URL = %q", e["DATABASE_URL"])
	}
	if e["STORAGE_DRIVER"] != "local" || e["MEDIA_DIR"] != p.Layout.Media || e["MEDIA_BASE_URL"] != "/media" {
		t.Errorf("media wiring wrong: %v %v %v", e["STORAGE_DRIVER"], e["MEDIA_DIR"], e["MEDIA_BASE_URL"])
	}
	// The api tells clients where to sync; that is the PUBLIC PowerSync port (Caddy's),
	// not the loopback one, or every phone gets an address it cannot reach.
	if e["POWERSYNC_PORT"] != "8083" {
		t.Errorf("POWERSYNC_PORT = %q, want the public 8083", e["POWERSYNC_PORT"])
	}
	for _, key := range []string{"LOCAL_JWT_SECRET", "TOKEN_ENCRYPTION_KEY", "POWERSYNC_JWT_PRIVATE_KEY"} {
		if e[key] == "" {
			t.Errorf("%s was not passed to the api", key)
		}
	}
	// Backups ARE enabled natively — the runtime takes them itself and writes the same
	// backup_runs rows the Compose sidecar does. BACKUP_ENABLED=false would make the
	// api's health check short-circuit to "turned off" and hide those rows, so a nightly
	// backup failing for a week would look exactly like one succeeding for a week.
	// Updates stay off: the Mac app owns those.
	if e["BACKUP_ENABLED"] != "true" {
		t.Errorf("BACKUP_ENABLED = %q, want true — System Health reads the rows the runtime writes",
			e["BACKUP_ENABLED"])
	}
	if e["UPDATE_CHECK_ENABLED"] != "false" {
		t.Errorf("UPDATE_CHECK_ENABLED = %q, want false", e["UPDATE_CHECK_ENABLED"])
	}
	// Provenance from the manifest, so System Health stops reporting sha "dev".
	if e["GIT_SHA"] != "a506c352" || e["BUILD_TIME"] != "2026-09-04T23:48:42.438Z" {
		t.Errorf("provenance not passed: GIT_SHA=%q BUILD_TIME=%q", e["GIT_SHA"], e["BUILD_TIME"])
	}
}

// The settings a household is meant to tune reach the api — every one of them a key the
// api reads, with the value config.env holds.
func TestHouseholdSettingsReachTheAPI(t *testing.T) {
	p := testPlan(t)
	want := map[string]string{
		"AI_TIMEOUT_MS":                "45000",
		"AI_MAX_RETRIES":               "1",
		"OIDC_NATIVE_REDIRECT_URI":     "waffled://auth/callback",
		"RATE_LIMIT_SETUP_MAX":         "6",
		"RATE_LIMIT_LOGIN_ACCOUNT_MAX": "11",
		"RATE_LIMIT_LOGIN_IP_MAX":      "51",
		"RATE_LIMIT_OIDC_START_MAX":    "31",
		"RATE_LIMIT_OIDC_EXCHANGE_MAX": "21",
		"RATE_LIMIT_REFRESH_MAX":       "61",
		"RATE_LIMIT_KIOSK_PAIR_MAX":    "12",
		"RATE_LIMIT_KIOSK_TOKEN_MAX":   "32",
		"RATE_LIMIT_MEDIA_MAX":         "33",
	}
	for k, v := range want {
		p.Env.Set(k, v)
	}
	got := envMap(p.API().Env)
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q in the api's environment, want %q", k, got[k], v)
		}
	}
}

// Logging is the household's to choose, within what the api understands. A value it does
// not know becomes the default here, so the environment says what is really in force.
func TestTheAPILogsTheWayConfigEnvAsks(t *testing.T) {
	for _, c := range []struct {
		level, format         string
		wantLevel, wantFormat string
	}{
		{"", "", "info", "json"},
		{"debug", "pretty", "debug", "pretty"},
		{"WARN", "json", "warn", "json"},
		{"error", "", "error", "json"},
		{"verbose", "text", "info", "json"},
	} {
		p := testPlan(t)
		p.Env.Set("LOG_LEVEL", c.level)
		p.Env.Set("LOG_FORMAT", c.format)
		e := envMap(p.API().Env)
		if e["LOG_LEVEL"] != c.wantLevel || e["LOG_FORMAT"] != c.wantFormat {
			t.Errorf("config.env %q/%q gave the api LOG_LEVEL=%q LOG_FORMAT=%q, want %q/%q",
				c.level, c.format, e["LOG_LEVEL"], e["LOG_FORMAT"], c.wantLevel, c.wantFormat)
		}
	}
}

// The allowlist is the boundary between a hand-edited config.env and the api's
// environment, so what stays OUT is pinned as deliberately as what goes in. OTEL only
// ever loads through the preload the bundle does not ship, the update notifier is off
// so its repo is never read, and AUTH0_DOMAIN switches the api into a different auth mode.
func TestKeysThatWouldDoNothingOrHarmStayOut(t *testing.T) {
	p := testPlan(t)
	for _, k := range []string{
		"OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "UPDATE_CHECK_REPO",
		"AUTH0_DOMAIN", "NODE_OPTIONS", "SOMETHING_ELSE",
	} {
		p.Env.Set(k, "x")
	}
	got := envMap(p.API().Env)
	for _, k := range []string{
		"OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "UPDATE_CHECK_REPO",
		"AUTH0_DOMAIN", "NODE_OPTIONS", "SOMETHING_ELSE",
	} {
		if _, ok := got[k]; ok {
			t.Errorf("%s reached the api's environment", k)
		}
	}
}

// otel.js is deliberately not in the bundle; a --require preload for it would make the
// api fail to boot with "Cannot find module".
func TestNodeOptionsPreloadIsNeverSet(t *testing.T) {
	p := testPlan(t)
	for _, spec := range []Spec{p.API(), p.PowerSync(), p.Migrate()} {
		if opts := envMap(spec.Env)["NODE_OPTIONS"]; strings.Contains(opts, "--require") {
			t.Errorf("%s: NODE_OPTIONS must never preload a module, got %q", spec.Name, opts)
		}
	}
}

func TestPowerSyncRunsUnifiedWithTheConfigAndAWritableCwd(t *testing.T) {
	p := testPlan(t)
	spec := p.PowerSync()

	args := strings.Join(spec.Args, " ")
	if !strings.Contains(args, "--max-old-space-size=1000") {
		t.Errorf("powersync argv missing the heap cap: %v", spec.Args)
	}
	if !strings.HasSuffix(args, "start -r unified") {
		t.Errorf("powersync must run `start -r unified`, got %v", spec.Args)
	}
	// It writes .probes/ into its cwd, and the bundle is read-only once signed.
	if spec.Dir != p.Layout.PowerSync {
		t.Errorf("powersync cwd = %q, want the data dir's powersync folder", spec.Dir)
	}

	e := envMap(spec.Env)
	if e["PS_PORT"] != "8084" {
		t.Errorf("PS_PORT = %q, want the loopback port", e["PS_PORT"])
	}
	if e["PS_DATA_SOURCE_URI"] != p.Env.DatabaseURL(5434, "waffled") {
		t.Errorf("PS_DATA_SOURCE_URI = %q", e["PS_DATA_SOURCE_URI"])
	}
	if e["PS_STORAGE_SOURCE_URI"] != p.Env.DatabaseURL(5434, "powersync_storage") {
		t.Errorf("PS_STORAGE_SOURCE_URI = %q, want the powersync_storage database", e["PS_STORAGE_SOURCE_URI"])
	}
	// The JWKS the api serves, on the api's loopback port.
	if e["PS_JWKS_URL"] != "http://127.0.0.1:3002/api/auth/keys" {
		t.Errorf("PS_JWKS_URL = %q", e["PS_JWKS_URL"])
	}
	if !strings.HasSuffix(e["POWERSYNC_CONFIG_PATH"], filepath.Join("powersync", "service.yaml")) {
		t.Errorf("POWERSYNC_CONFIG_PATH = %q", e["POWERSYNC_CONFIG_PATH"])
	}
}

func TestCaddyGetsBothSiteAddressesAndItsOwnState(t *testing.T) {
	p := testPlan(t)
	spec := p.Caddy()

	if spec.Path != filepath.Join(p.Bundle, "bin", "caddy") {
		t.Errorf("caddy path = %q", spec.Path)
	}
	args := strings.Join(spec.Args, " ")
	if !strings.Contains(args, "run") || !strings.Contains(args, "--adapter caddyfile") {
		t.Errorf("caddy argv = %v", spec.Args)
	}
	if !strings.Contains(args, p.Layout.CaddyfilePath) {
		t.Errorf("caddy must use the generated Caddyfile, got %v", spec.Args)
	}

	e := envMap(spec.Env)
	if e["CADDY_SITE_ADDRESS"] != ":8082" {
		t.Errorf("CADDY_SITE_ADDRESS = %q", e["CADDY_SITE_ADDRESS"])
	}
	if e["POWERSYNC_CADDY_ADDRESS"] != ":8083" {
		t.Errorf("POWERSYNC_CADDY_ADDRESS = %q", e["POWERSYNC_CADDY_ADDRESS"])
	}
	// Caddy's autosave.json and local CA must land in the data dir, not ~/.local/share.
	if e["XDG_DATA_HOME"] != p.Layout.Caddy || e["XDG_CONFIG_HOME"] != p.Layout.Caddy {
		t.Errorf("caddy state not confined: %q / %q", e["XDG_DATA_HOME"], e["XDG_CONFIG_HOME"])
	}
}

func TestMigrateIsAOneShotWithTheDatabaseURL(t *testing.T) {
	p := testPlan(t)
	spec := p.Migrate()
	if !spec.OneShot {
		t.Error("migrate must be a one-shot, not a supervised child")
	}
	if spec.Args[len(spec.Args)-1] != filepath.Join(p.Bundle, "api", "dist", "migrate.js") {
		t.Errorf("migrate argv = %v", spec.Args)
	}
	e := envMap(spec.Env)
	if e["DATABASE_URL"] == "" {
		t.Error("migrate needs DATABASE_URL")
	}
	// migrate.js resolves ../migrations relative to itself, so it must run from the
	// bundle's own dist directory layout — never a copy that flattens it.
	if !strings.HasSuffix(spec.Args[len(spec.Args)-1], filepath.Join("api", "dist", "migrate.js")) {
		t.Errorf("migrate must run the bundled dist/migrate.js so ../migrations resolves: %v", spec.Args)
	}
}

// `admin` is the break-glass CLI the Docker install runs with `docker exec waffled-api
// node dist/admin.js`. Natively it is the same file, run by the bundled node with the
// api's database environment — and the path is derived from migrate's, so a bundle that
// moves api/dist says so in one place.
func TestAdminRunsTheBundledAdminCLIWithTheAPIsDatabase(t *testing.T) {
	p := testPlan(t)
	spec := p.Admin([]string{"reset-password", "--email", "a@b"})

	if spec.Path != filepath.Join(p.Bundle, "bin", "node") {
		t.Errorf("admin must run the bundled node, got %q", spec.Path)
	}
	want := []string{
		spec.Path, filepath.Join(p.Bundle, "api", "dist", "admin.js"),
		"reset-password", "--email", "a@b",
	}
	if !reflect.DeepEqual(spec.Args, want) {
		t.Errorf("admin argv = %q, want %q", spec.Args, want)
	}
	p.Env.Set("ACCESS_TOKEN_TTL_SECONDS", "900")
	e := envMap(p.Admin(nil).Env)
	if e["DATABASE_URL"] != p.Env.DatabaseURL(5434, "waffled") {
		t.Errorf("DATABASE_URL = %q", e["DATABASE_URL"])
	}
	// The api's own settings reach it too: a session prune and a password reset are
	// governed by the same token lifetimes the api runs with.
	if e["ACCESS_TOKEN_TTL_SECONDS"] != "900" {
		t.Errorf("ACCESS_TOKEN_TTL_SECONDS = %q, want the household's own 900", e["ACCESS_TOKEN_TTL_SECONDS"])
	}
	// setPersonLogin encrypts and signs with these; without them a reset writes a login
	// nothing can verify.
	for _, key := range []string{"LOCAL_JWT_SECRET", "TOKEN_ENCRYPTION_KEY"} {
		if e[key] == "" {
			t.Errorf("%s was not passed to admin", key)
		}
	}
	if e["PATH"] != "/usr/bin:/bin" {
		t.Errorf("PATH = %q, want a minimal one", e["PATH"])
	}
}

func TestHealthURLsMatchTheServicesTheyProbe(t *testing.T) {
	p := testPlan(t)
	// The api's own health gate is /healthz: /api/health is admin-only and answers 401.
	if got := p.API().HealthURL; got != "http://127.0.0.1:3002/healthz" {
		t.Errorf("api health = %q", got)
	}
	if got := p.PowerSync().HealthURL; got != "http://127.0.0.1:8084/probes/liveness" {
		t.Errorf("powersync health = %q", got)
	}
	if got := p.Caddy().HealthURL; got != "http://127.0.0.1:8082/healthz" {
		t.Errorf("caddy health = %q", got)
	}
}

func TestPostgresBringUpIsLoopbackOnlyAndLogical(t *testing.T) {
	p := testPlan(t)
	conf := p.PostgresConf()
	for _, want := range []string{
		"listen_addresses = '127.0.0.1'",
		"port = 5434",
		"wal_level = logical",
		"max_replication_slots = 10",
		"max_wal_senders = 10",
		"password_encryption = scram-sha-256",
	} {
		if !strings.Contains(conf, want) {
			t.Errorf("postgresql.conf missing %q:\n%s", want, conf)
		}
	}
	if !strings.Contains(conf, "unix_socket_directories = '"+p.SocketDir+"'") {
		t.Errorf("socket directory must be set and quoted:\n%s", conf)
	}

	hba := p.PostgresHBA()
	if strings.Contains(hba, "trust") {
		t.Errorf("pg_hba.conf must never use trust:\n%s", hba)
	}
	if !strings.Contains(hba, "host    all          all   127.0.0.1/32   scram-sha-256") {
		t.Errorf("loopback scram rule missing:\n%s", hba)
	}
	// PowerSync opens a logical replication slot; without this line liveness still goes
	// green and only replication is dead.
	if !strings.Contains(hba, "replication") {
		t.Errorf("pg_hba.conf needs a replication rule for PowerSync:\n%s", hba)
	}
	if strings.Contains(hba, "0.0.0.0/0") || strings.Contains(hba, "all   all   all") {
		t.Errorf("pg_hba.conf must not open beyond loopback:\n%s", hba)
	}
}

// The cluster must be created with the same collation the postgres:16 image uses, or a
// family restoring a Docker backup onto the Mac app gets different sort order and
// collation-mismatch warnings on every index.
func TestInitdbUsesTheDockerImageCollation(t *testing.T) {
	p := testPlan(t)
	args := strings.Join(p.InitdbArgs("/tmp/pw"), " ")
	if !strings.Contains(args, "--encoding=UTF8") {
		t.Errorf("initdb args = %s", args)
	}
	if !strings.Contains(args, "--locale=en_US.UTF-8") {
		t.Errorf("initdb must match the postgres:16 image's en_US.utf8 collation, got %s", args)
	}
	if strings.Contains(args, "--locale=C") {
		t.Errorf("--locale=C would change sort order relative to Docker: %s", args)
	}
	if !strings.Contains(args, "--auth=scram-sha-256") {
		t.Errorf("initdb must use scram from the first byte: %s", args)
	}
	if !strings.Contains(args, "-U waffled") {
		t.Errorf("the superuser should be POSTGRES_USER, as the image does: %s", args)
	}
}

// The password must reach psql through the environment, never argv — argv is visible in
// `ps` to every process on the Mac, which would undo the 0600 on config.env.
func TestPsqlTakesThePasswordFromTheEnvironment(t *testing.T) {
	p := testPlan(t)
	spec := p.Psql("waffled", "/bundle/config/00-init.sql")
	for _, arg := range spec.Args {
		if strings.Contains(arg, p.Env.Get(configenv.KeyPostgresPassword)) {
			t.Fatalf("the password appears in argv: %v", spec.Args)
		}
	}
	if envMap(spec.Env)["PGPASSWORD"] != p.Env.Get(configenv.KeyPostgresPassword) {
		t.Error("PGPASSWORD should carry the password")
	}
	if !strings.Contains(strings.Join(spec.Args, " "), "ON_ERROR_STOP=1") {
		t.Errorf("psql must stop on the first error: %v", spec.Args)
	}
}

func TestBinaryPathsComeFromTheBundle(t *testing.T) {
	p := testPlan(t)
	for name, got := range map[string]string{
		"initdb":     p.PostgresBin("initdb"),
		"pg_ctl":     p.PostgresBin("pg_ctl"),
		"pg_isready": p.PostgresBin("pg_isready"),
		"psql":       p.PostgresBin("psql"),
	} {
		want := filepath.Join(p.Bundle, "bin", "postgres", "bin", name)
		if got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}
