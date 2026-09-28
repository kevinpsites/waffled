//go:build integration

// The end-to-end test for Phase 2: bring the real bundle up from an empty data
// directory, prove it is green and confined to loopback, stop it, and start it again
// onto the same data.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration ./...
//
// It is skipped without WAFFLED_BUNDLE so `go test ./...` stays fast and hermetic.
package runtime_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

func bundleDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("WAFFLED_BUNDLE")
	if dir == "" {
		t.Skip("set WAFFLED_BUNDLE to the runtime bundle directory to run the integration test")
	}
	return dir
}

// dataDir returns a throwaway data directory whose path CONTAINS A SPACE — the default
// is ~/Library/Application Support/Waffled, so a space is the normal case and anything
// that quotes badly (the Caddyfile roots, postgresql.conf) has to survive it here.
func dataDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Application Support", "Waffled")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dir, " ") {
		t.Fatalf("the test data directory must contain a space, got %q", dir)
	}
	return dir
}

func newSupervisor(t *testing.T, bundle, data string) *supervisor.Supervisor {
	t.Helper()
	s, err := supervisor.New(supervisor.Options{
		BundleDir: bundle,
		DataDir:   data,
		Log:       supervisor.NewLogger(&testWriter{t}, false),
	})
	if err != nil {
		t.Fatalf("supervisor.New: %v", err)
	}
	return s
}

// TestStackComesUpAndBackDown is the Phase 2 exit criterion: green from an empty data
// directory, then stop/start re-opening the same data.
func TestStackComesUpAndBackDown(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)

	// Whatever happens below, nothing may be left listening. This runs even on a
	// t.Fatal midway through the start sequence.
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		if err := s.Stop(stopCtx); err != nil {
			t.Errorf("cleanup stop: %v", err)
		}
		killLeftovers(t, data)
	})

	// ── cold start ──────────────────────────────────────────────────────────────
	coldStart := time.Now()
	if err := s.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("cold start failed: %v", err)
	}
	cold := time.Since(coldStart)
	ports := s.Plan().Ports
	t.Logf("COLD START (empty data dir, initdb + migrations + manifest verify): %s", cold.Round(10*time.Millisecond))
	t.Logf("ports: public %d, powersync public %d, api %d, powersync %d, postgres %d",
		ports.Public, ports.PowerSyncPublic, ports.API, ports.PowerSync, ports.Postgres)

	// Plan §7 sets the exit criterion at under 60s on a fresh Mac account.
	if cold > 60*time.Second {
		t.Errorf("cold start took %s — the plan's exit criterion is under 60s", cold.Round(time.Second))
	}

	// ── everything is green ─────────────────────────────────────────────────────
	report := s.Status(ctx)
	if report.State != status.StateRunning {
		t.Errorf("overall state = %q, want running:\n%s", report.State, report.Text())
	}
	if len(report.Services) != 4 {
		t.Fatalf("expected four services, got %d", len(report.Services))
	}
	for _, svc := range report.Services {
		if svc.State != status.StateRunning {
			t.Errorf("%s is %q (health %q, last error %q)", svc.Name, svc.State, svc.Health, svc.LastError)
		}
		if svc.PID == 0 {
			t.Errorf("%s has no pid", svc.Name)
		}
	}
	if report.Versions.Waffled == "" || report.Bundle.GitSha == "" {
		t.Errorf("status is missing bundle provenance: %+v", report.Bundle)
	}

	// status --json must round-trip: it is the menu-bar app's contract.
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var reparsed status.Report
	if err := json.Unmarshal(raw, &reparsed); err != nil {
		t.Fatalf("status --json does not round-trip: %v", err)
	}

	// ── the endpoints a browser, a phone and PowerSync actually use ─────────────
	base := fmt.Sprintf("http://127.0.0.1:%d", ports.Public)
	assertStatus(t, base+"/healthz", 200)
	// /api/health is admin-only: a 401 through Caddy still proves the proxy reaches the
	// api, which is the thing this asserts.
	assertStatusIn(t, base+"/api/health", 200, 401)
	// The SPA itself.
	assertStatus(t, base+"/", 200)
	// PowerSync through its own Caddy site.
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/probes/liveness", ports.PowerSyncPublic), 200)
	// And directly on the loopback ports.
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", ports.API), 200)
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/probes/liveness", ports.PowerSync), 200)
	// The JWKS PowerSync validates client tokens against.
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/api/auth/keys", ports.API), 200)

	// ── network confinement (plan §5: the replacement for the compose network) ──
	//
	// Postgres is the one that must hold: it is the data, and natively there is no
	// container network in front of it.
	assertLoopbackOnly(t, "postgres", ports.Postgres)

	// The other two are known gaps, asserted in the direction of travel so each turns
	// into a real pass the day it is fixed rather than being forgotten.
	//
	// api: binds 0.0.0.0 until the HOST change (PR #177) merges. HOST=127.0.0.1 is
	// already in its environment, so this starts passing the day that lands.
	assertLoopbackWhenFixed(t, "api", ports.API,
		"the api honours HOST only once PR #177 merges; HOST=127.0.0.1 is already being passed")
	// powersync: `host: '0.0.0.0'` is hardcoded in the service's own listen call
	// (modules/module-core, CoreModule) — there is no config key and no PS_* variable
	// for it, so the runtime cannot confine it. Requests still need an RS256 token our
	// api minted, so this is a missing layer of defence rather than an open door; the
	// fix is upstream or a packet-filter rule, and it is recorded in the README.
	assertLoopbackWhenFixed(t, "powersync", ports.PowerSync,
		"powersync hardcodes host: '0.0.0.0' in its listen call — no config key or env var exists to change it")
}

// The cluster must match the collation the postgres:16 image creates, so a household
// moving from Docker by restoring a dump keeps the same sort order.
func TestClusterCollationMatchesTheDockerImage(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		_ = s.Stop(stopCtx)
		killLeftovers(t, data)
	})
	if err := s.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("start: %v", err)
	}

	for _, db := range []string{s.Plan().Env.PostgresDB(), services.StorageDatabase} {
		collate, ctype, err := s.Collation(ctx, db)
		if err != nil {
			t.Fatalf("read the collation of %s: %v", db, err)
		}
		t.Logf("%s: datcollate=%s datctype=%s", db, collate, ctype)
		if !supervisor.SameLocale(collate, services.InitdbCollation) {
			t.Errorf("%s datcollate = %q, want %s (the postgres:16 image's locale)", db, collate, services.InitdbCollation)
		}
		if !supervisor.SameLocale(ctype, services.InitdbCollation) {
			t.Errorf("%s datctype = %q, want %s", db, ctype, services.InitdbCollation)
		}
	}
}

// A restart must re-open the same data: the same secrets, no second initdb, and
// migrations that no-op.
func TestRestartReopensTheSameData(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	first := newSupervisor(t, bundle, data)
	if err := first.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("first start: %v", err)
	}
	firstPorts := first.Plan().Ports
	secretsBefore := readSecrets(t, data)
	pgVersionBefore := statMtime(t, filepath.Join(data, "postgres", "PG_VERSION"))
	migrationsBefore := appliedMigrations(ctx, t, first)
	if migrationsBefore < 90 {
		t.Errorf("expected the full migration set to have been applied, got %d", migrationsBefore)
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 3*time.Minute)
	if err := first.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	stopCancel()

	// Nothing may still be listening after stop.
	for name, port := range map[string]int{
		"public": firstPorts.Public, "powersync public": firstPorts.PowerSyncPublic,
		"api": firstPorts.API, "powersync": firstPorts.PowerSync, "postgres": firstPorts.Postgres,
	} {
		if isListening(port) {
			t.Errorf("after stop, something is still listening on the %s port %d: %s",
				name, port, describeHolder(port))
		}
	}

	// ── warm start onto the same data ───────────────────────────────────────────
	second := newSupervisor(t, bundle, data)
	warmStart := time.Now()
	if err := second.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("second start: %v", err)
	}
	warm := time.Since(warmStart)
	t.Logf("WARM START (existing cluster, cached manifest, migrations no-op): %s", warm.Round(10*time.Millisecond))

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cleanupCancel()
		_ = second.Stop(cleanupCtx)
		killLeftovers(t, data)
	})

	// The public port must be stable — every paired device points at it.
	if got := second.Plan().Ports; got != firstPorts {
		t.Errorf("ports moved between runs:\n first %+v\nsecond %+v", firstPorts, got)
	}
	// Same secrets: a regenerated LOCAL_JWT_SECRET would sign everyone out, and a
	// regenerated POWERSYNC_JWT_PRIVATE_KEY would break every client's sync token.
	for key, before := range secretsBefore {
		if after := readSecrets(t, data)[key]; after != before {
			t.Errorf("%s was regenerated on the second start — every client would be signed out", key)
		}
	}
	// No second initdb.
	if after := statMtime(t, filepath.Join(data, "postgres", "PG_VERSION")); !after.Equal(pgVersionBefore) {
		t.Errorf("PG_VERSION changed (%s → %s) — the cluster was re-initialised", pgVersionBefore, after)
	}
	// Migrations were a no-op. The bundled runner is quiet about which files it applied,
	// so count the applied set instead: node-pg-migrate records one row per migration in
	// pgmigrations, and a second start must add none.
	migrationsAfter := appliedMigrations(ctx, t, second)
	if migrationsAfter != migrationsBefore {
		t.Errorf("the second start applied %d migration(s) — it should have been a no-op (%d → %d)",
			migrationsAfter-migrationsBefore, migrationsBefore, migrationsAfter)
	}
	t.Logf("migrations: %d applied on the first start, unchanged on the second", migrationsAfter)

	migrateLog := readFile(t, filepath.Join(data, "logs", "migrate.log"))
	if strings.Count(migrateLog, "── ") < 2 {
		t.Errorf("expected two migrate runs recorded in migrate.log:\n%s", migrateLog)
	}
	if !strings.Contains(migrateLog, "schema up to date") {
		t.Errorf("migrate did not report success:\n%s", tailString(migrateLog, 15))
	}

	report := second.Status(ctx)
	if report.State != status.StateRunning {
		t.Errorf("after restart, state = %q:\n%s", report.State, report.Text())
	}
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", second.Plan().Ports.Public), 200)
}

// TestDetachedStartStop drives the real binary the way a person in Terminal and the
// menu-bar app will: `start` (which re-execs itself with --foreground under setsid),
// `status --json`, then `stop`. This is the only test that exercises the daemonize
// path — everything else calls Start/Stop in-process — so it is what proves the
// supervisor pidfile, the re-exec and the signalled shutdown actually work.
func TestDetachedStartStop(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)
	bin := buildBinary(t)

	// Ensure a failure mid-test cannot leave a detached supervisor running.
	t.Cleanup(func() {
		_, _ = runCLI(t, bin, 3*time.Minute, "stop", "--bundle", bundle, "--data", data)
		killLeftovers(t, data)
	})

	coldStart := time.Now()
	out, err := runCLI(t, bin, 5*time.Minute, "start", "--bundle", bundle, "--data", data)
	cold := time.Since(coldStart)
	if err != nil {
		dumpLogs(t, data)
		t.Fatalf("start: %v\n%s", err, out)
	}
	t.Logf("COLD START via the CLI (detached; verifies the bundle in both the parent and the child): %s",
		cold.Round(10*time.Millisecond))
	if !strings.Contains(out, "Waffled is running") {
		t.Errorf("start should say where to open it, got:\n%s", out)
	}

	// The supervisor pidfile is what `stop` and the app find it by.
	supervisorPid := readFile(t, filepath.Join(data, "pids", "supervisor.pid"))
	if strings.TrimSpace(supervisorPid) == "" {
		t.Error("start did not record a supervisor pid")
	}

	statusOut, err := runCLIJSON(t, bin, time.Minute, "status", "--json", "--bundle", bundle, "--data", data)
	if err != nil {
		t.Fatalf("status --json: %v\n%s", err, statusOut)
	}
	var report status.Report
	if err := json.Unmarshal([]byte(statusOut), &report); err != nil {
		t.Fatalf("status --json is not valid JSON: %v\n%s", err, statusOut)
	}
	if report.State != status.StateRunning {
		t.Errorf("state = %q, want running:\n%s", report.State, statusOut)
	}
	if !report.Supervisor.Running || report.Supervisor.PID == 0 {
		t.Errorf("status should report the running supervisor, got %+v", report.Supervisor)
	}
	if report.Schema != status.Schema {
		t.Errorf("schema = %d, want %d", report.Schema, status.Schema)
	}
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", report.Ports.Public), 200)

	// doctor must run and pass against a healthy stack.
	doctorOut, err := runCLI(t, bin, 2*time.Minute, "doctor", "--bundle", bundle, "--data", data)
	if err != nil {
		t.Errorf("doctor on a healthy stack should pass: %v\n%s", err, doctorOut)
	}
	t.Logf("doctor:\n%s", doctorOut)

	stopOut, err := runCLI(t, bin, 3*time.Minute, "stop", "--bundle", bundle, "--data", data)
	if err != nil {
		t.Fatalf("stop: %v\n%s", err, stopOut)
	}
	// The supervisor removes its own pidfile as it exits.
	if _, err := os.Stat(filepath.Join(data, "pids", "supervisor.pid")); !os.IsNotExist(err) {
		t.Error("stop left the supervisor pidfile behind")
	}
	for name, port := range map[string]int{
		"public": report.Ports.Public, "powersync public": report.Ports.PowerSyncPublic,
		"api": report.Ports.API, "powersync": report.Ports.PowerSync, "postgres": report.Ports.Postgres,
	} {
		if isListening(port) {
			t.Errorf("after `stop`, something is still listening on the %s port %d:\n%s",
				name, port, describeHolder(port))
		}
	}

	// And `status` on a stopped stack still produces a document rather than an error.
	statusOut, err = runCLIJSON(t, bin, time.Minute, "status", "--json", "--bundle", bundle, "--data", data)
	if err != nil {
		t.Fatalf("status --json on a stopped stack: %v\n%s", err, statusOut)
	}
	if err := json.Unmarshal([]byte(statusOut), &report); err != nil {
		t.Fatalf("status --json on a stopped stack is not valid JSON: %v\n%s", err, statusOut)
	}
	if report.State != status.StateStopped {
		t.Errorf("after stop, state = %q, want stopped", report.State)
	}
}

// A tampered bundle must never be executed.
func TestATamperedBundleIsRefused(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	// Copy just enough of a bundle to tamper with, rather than touching the real one.
	fake := filepath.Join(t.TempDir(), "runtime")
	if err := os.MkdirAll(filepath.Join(fake, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	copyFile(t, filepath.Join(bundle, "manifest.json"), filepath.Join(fake, "manifest.json"))
	copyFile(t, filepath.Join(bundle, "config", "Caddyfile"), filepath.Join(fake, "config", "Caddyfile"))

	_, err := supervisor.New(supervisor.Options{
		BundleDir: fake, DataDir: data,
		Log: supervisor.NewLogger(&testWriter{t}, true),
	})
	if err == nil {
		t.Fatal("a bundle that does not match its manifest must be refused")
	}
	if !strings.Contains(err.Error(), "manifest") {
		t.Errorf("the refusal should mention the manifest, got %q", err)
	}
	t.Logf("refused as expected: %s", firstLine(err.Error()))
}

// ── helpers ──────────────────────────────────────────────────────────────────

// buildBinary compiles the real CLI, so the detached test drives what ships rather than
// an in-process approximation of it.
func buildBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "waffled-runtime")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/waffled-runtime")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build waffled-runtime: %v\n%s", err, out)
	}
	return bin
}

func runCLI(t *testing.T, bin string, timeout time.Duration, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// runCLIJSON captures stdout ALONE. --json output is a contract another program parses,
// so it must not be polluted by anything the logger writes to stderr — and asserting
// that here is what keeps it true.
func runCLIJSON(t *testing.T, bin string, timeout time.Duration, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if stderr.Len() > 0 {
		t.Logf("stderr from %v:\n%s", args, stderr.String())
	}
	return stdout.String(), err
}

func assertStatus(t *testing.T, url string, want int) {
	t.Helper()
	assertStatusIn(t, url, want)
}

func assertStatusIn(t *testing.T, url string, want ...int) {
	t.Helper()
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Get(url)
	if err != nil {
		t.Errorf("GET %s: %v", url, err)
		return
	}
	defer resp.Body.Close()
	for _, code := range want {
		if resp.StatusCode == code {
			return
		}
	}
	t.Errorf("GET %s → %d, want one of %v", url, resp.StatusCode, want)
}

// assertLoopbackOnly proves a service is not reachable from the network: binding the
// same port on the wildcard address only succeeds if nothing already holds 0.0.0.0:port,
// while connecting on 127.0.0.1 must still work.
func assertLoopbackOnly(t *testing.T, name string, port int) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		t.Errorf("%s should be reachable on 127.0.0.1:%d: %v", name, port, err)
		return
	}
	conn.Close()

	if boundOnAllInterfaces(port) {
		t.Errorf("%s on port %d is bound to all interfaces — it must be loopback only (plan §5):\n%s",
			name, port, describeHolder(port))
		return
	}
	t.Logf("%s on port %d is loopback only", name, port)
}

// assertLoopbackWhenFixed records a service we cannot confine yet. It reports the gap
// rather than failing — the cause is outside this binary — but it fails loudly if the
// service is not even reachable, and it says so plainly the day the binding is fixed, so
// the reason on record here can be deleted.
func assertLoopbackWhenFixed(t *testing.T, name string, port int, why string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		t.Errorf("%s should be reachable on 127.0.0.1:%d: %v", name, port, err)
		return
	}
	conn.Close()

	if boundOnAllInterfaces(port) {
		t.Logf("KNOWN GAP: %s on port %d is bound to all interfaces — %s", name, port, why)
		return
	}
	t.Logf("%s on port %d is loopback only — the gap is closed; drop the exemption in this test (%s)", name, port, why)
}

// boundOnAllInterfaces asks lsof which address holds the port. It is the authority here:
// a net.Listen probe on 0.0.0.0 can succeed on macOS even when a loopback listener
// exists, so it cannot answer this question on its own.
func boundOnAllInterfaces(port int) bool {
	out, err := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}
		addr := fields[8]
		if strings.HasPrefix(addr, "*:") || strings.HasPrefix(addr, "0.0.0.0:") {
			return true
		}
	}
	return false
}

func isListening(port int) bool {
	out, err := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN").Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
}

func describeHolder(port int) string {
	out, _ := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN").Output()
	return strings.TrimSpace(string(out))
}

// killLeftovers is the backstop for the spec's "make sure nothing you started is still
// listening": if a test failed midway, the pidfiles still name our processes.
func killLeftovers(t *testing.T, data string) {
	t.Helper()
	layout := datadir.At(data)
	entries, err := os.ReadDir(layout.Pids)
	if err != nil {
		return
	}
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join(layout.Pids, e.Name()))
		if err != nil {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err != nil || pid <= 0 {
			continue
		}
		if proc, err := os.FindProcess(pid); err == nil {
			if err := proc.Signal(os.Signal(nil)); err == nil {
				t.Logf("killing leftover process %d from %s", pid, e.Name())
			}
			_ = proc.Kill()
		}
	}
	// And the postmaster, which does not use our pids directory.
	if raw, err := os.ReadFile(filepath.Join(layout.Postgres, "postmaster.pid")); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(strings.SplitN(string(raw), "\n", 2)[0])); err == nil && pid > 0 {
			if proc, err := os.FindProcess(pid); err == nil {
				_ = proc.Kill()
			}
		}
	}
}

func dumpLogs(t *testing.T, data string) {
	t.Helper()
	layout := datadir.At(data)
	entries, err := os.ReadDir(layout.Logs)
	if err != nil {
		t.Logf("no logs in %s", layout.Logs)
		return
	}
	for _, e := range entries {
		body := readFile(t, filepath.Join(layout.Logs, e.Name()))
		t.Logf("──── %s ────\n%s", e.Name(), tailString(body, 40))
	}
}

// appliedMigrations counts the rows node-pg-migrate keeps in pgmigrations — one per
// applied migration. Comparing it across a restart is what "the migrations were a
// no-op" actually means.
func appliedMigrations(ctx context.Context, t *testing.T, s *supervisor.Supervisor) int {
	t.Helper()
	out, err := s.QueryScalar(ctx, s.Plan().Env.PostgresDB(), "select count(*) from pgmigrations")
	if err != nil {
		t.Fatalf("count applied migrations: %v", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		t.Fatalf("unexpected migration count %q: %v", out, err)
	}
	return n
}

func readSecrets(t *testing.T, data string) map[string]string {
	t.Helper()
	env, err := configenv.Load(datadir.At(data).ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, key := range []string{
		configenv.KeyLocalJWTSecret, configenv.KeyTokenEncryptionKey,
		configenv.KeyPostgresPassword, configenv.KeyPowerSyncJWTPrivateKey,
	} {
		out[key] = env.Get(key)
	}
	return out
}

func statMtime(t *testing.T, path string) time.Time {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return st.ModTime()
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func tailString(s string, lines int) string {
	all := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

type testWriter struct{ t *testing.T }

func (w *testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}
