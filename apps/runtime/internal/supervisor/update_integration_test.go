//go:build integration

// The update path, across two genuinely different bundle versions, against one data dir.
//
// The decision this proves (docs/product/native-mac-plan.md §6): the Mac app is ONE unit.
// Sparkle swaps the whole Waffled.app — runtime bundle inside — relaunches, and the
// menu-bar app runs `waffled-runtime start` from the NEW bundle against the EXISTING data
// directory. A start from a newer bundle IS the update. There is no binary-swap step for
// the runtime to perform and no old bundle left on disk to fall back to, so "rollback" is
// two halves: the runtime protects the DATA (snapshot → migrate → health gate → restore),
// and a person recovers AVAILABILITY by re-installing the previous DMG — which must then
// start cleanly on the restored data, or refuse in a way they can act on.
//
// Every other test here runs one bundle. This one runs the loop end to end, which is the
// only way to catch the things that only exist BETWEEN versions: a snapshot named for the
// wrong crossing, a status field that never reaches disk, an older build that opens data
// it cannot serve, and a full stack starting on a database rollbackTo has just replaced.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration -run TestUpdate ./internal/supervisor/
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

// The migration bundle B adds. A leaf table nothing else references, with a Down that
// fully undoes it — the same properties that make 0096 safe to rewind in the rollback
// test, because this one gets rewound too.
const (
	probeMigration = "0100_update_probe"
	probeSQL       = `-- Up Migration
-- Added by update_integration_test.go to make bundle B genuinely newer than bundle A.
-- A leaf table nothing references, so applying and reversing it touches nothing else.

create table if not exists update_probe (
  id   integer primary key,
  note text not null
);

-- Down Migration

drop table if exists update_probe;
`
)

// TestUpdateAcrossTwoBundleVersions is the whole loop, in one data directory:
//
//	A → canary → B (update) → B with a failing health gate (rollback)
//	  → A again (re-install the previous DMG) → B → A (refused)
//
// One function on purpose. Every phase depends on the state the previous one left, and
// splitting them would mean either re-doing the expensive parts or sharing state through
// package variables — which is how a suite starts passing for reasons nobody can name.
func TestUpdateAcrossTwoBundleVersions(t *testing.T) {
	bundleA := os.Getenv("WAFFLED_BUNDLE")
	if bundleA == "" {
		// Before the clone: 662 MB is not something to copy on the way to a skip.
		t.Skip("set WAFFLED_BUNDLE to the runtime bundle directory to run the integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	started := time.Now()

	versionA := bundleVersionOf(t, bundleA)
	bundleB := deriveNewerBundle(t, bundleA)
	versionB := bundleVersionOf(t, bundleB)
	if versionA == versionB {
		t.Fatalf("bundle B still claims version %s; the test proves nothing", versionB)
	}
	t.Logf("bundle A is %s, bundle B is %s (+ %s)", versionA, versionB, probeMigration)

	// One data directory for the whole run, with a space in the path like the real
	// ~/Library/Application Support/Waffled.
	data := filepath.Join(t.TempDir(), "Application Support", "Waffled")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	db := ""
	const canary = "update-canary"

	// ── phase 1: the household is running the old version ───────────────────────
	t.Log("phase 1: start A on an empty data directory and write a canary row")
	sA := newSupervisorOn(t, bundleA, data)
	if err := sA.Start(ctx); err != nil {
		t.Fatalf("start A: %v", err)
	}
	db = sA.plan.Env.PostgresDB()
	if _, err := sA.QueryScalar(ctx, db,
		"create table if not exists update_canary (note text); "+
			"insert into update_canary values ('"+canary+"')"); err != nil {
		t.Fatalf("write the canary row: %v", err)
	}
	if snaps := snapshotFiles(t, data); len(snaps) != 0 {
		t.Errorf("a first start took a snapshot it did not need: %v", snaps)
	}
	stopNow(t, sA)

	// ── phase 2: Sparkle swapped the app; the new bundle starts ─────────────────
	t.Log("phase 2: start B against the same data — this IS the update")
	sB := newSupervisorOn(t, bundleB, data)
	if err := sB.Start(ctx); err != nil {
		t.Fatalf("start B (the update): %v", err)
	}

	snaps := snapshotFiles(t, data)
	if len(snaps) != 1 {
		t.Fatalf("the update took %d snapshots, want exactly 1: %v", len(snaps), snaps)
	}
	// The name has to carry the crossing. Someone looking at this directory a month
	// later is asking "which way was it going?", and only the name is in front of them.
	wantName := backup.SnapshotName(versionA, versionB, time.Now())
	gotName := filepath.Base(snaps[0])
	if prefix := wantName[:strings.LastIndex(wantName, "-2")]; !strings.HasPrefix(gotName, prefix) {
		t.Errorf("the snapshot is called %s, want it to start %s — the name must record both versions",
			gotName, prefix)
	}
	side, ok := backup.ReadSidecar(snaps[0])
	if !ok {
		t.Fatal("no sidecar beside the update's snapshot")
	}
	if side.FromVersion != versionA || side.ToVersion != versionB {
		t.Errorf("the sidecar records the crossing as %q→%q, want %q→%q",
			side.FromVersion, side.ToVersion, versionA, versionB)
	}
	if side.Migration == probeMigration {
		t.Errorf("the snapshot was taken AFTER %s was applied — a rollback point that already "+
			"holds the schema change is no rollback point at all", probeMigration)
	}

	// The migration ran, the household's data is untouched, and the server is green.
	if got := scalar(t, ctx, sB, db, "select to_regclass('public.update_probe') is not null"); got != "t" {
		t.Errorf("update_probe does not exist after starting B — the new migration did not run")
	}
	if got := scalar(t, ctx, sB, db, "select note from update_canary"); got != canary {
		t.Errorf("canary = %q, want %q — the update lost data", got, canary)
	}
	for _, name := range []string{services.API, services.PowerSync, services.Caddy} {
		if !sB.serviceRunning(name) {
			t.Errorf("%s is not running after the update", name)
		}
	}

	// Read through a FRESH supervisor: the menu-bar app is a separate process, so a
	// field that only ever lived in the one that did the updating would be invisible to
	// it — and passing here on in-memory state is the easiest way for this to lie.
	fresh := newSupervisorOn(t, bundleB, data)
	rep := fresh.Status(ctx)
	if rep.Bundle.Version != versionB {
		t.Errorf("status reports bundle.version %q, want %q", rep.Bundle.Version, versionB)
	}
	if rep.Bundle.PreviousVersion != versionA {
		t.Errorf("status reports bundle.previousVersion %q, want %q", rep.Bundle.PreviousVersion, versionA)
	}
	if rep.Bundle.VersionChangedAt == "" {
		t.Error("status reports no bundle.updatedAt, so the menu bar cannot say when the update happened")
	}
	if rep.State != status.StateRunning {
		t.Errorf("status reports %q after a successful update, want %q", rep.State, status.StateRunning)
	}
	stopNow(t, sB)

	// ── phase 3: the same update, but the api cannot serve the new schema ───────
	t.Logf("phase 3: rewind %s and start B again with a failing api health gate", probeMigration)
	rewind := newSupervisorOn(t, bundleB, data)
	pgStop, err := rewind.ensurePostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rewind.QueryScalar(ctx, db,
		"drop table if exists update_probe; delete from pgmigrations where name = '"+probeMigration+"'"); err != nil {
		t.Fatalf("rewind %s: %v", probeMigration, err)
	}
	pgStop()

	sFail := newSupervisorOn(t, bundleB, data)
	// The gate fails for real; every other step — snapshot, migrate, launching the api —
	// runs exactly as it does on a household's Mac. Swapping the unexported prober is the
	// only way to reach this without shipping a way for a household to trip it.
	sFail.waitHealthy = func(ctx context.Context, url string, timeout time.Duration, alive func() error) error {
		if strings.Contains(url, "/healthz") && strings.Contains(url, fmt.Sprintf(":%d", sFail.plan.Ports.API)) {
			return fmt.Errorf("forced failure: the api is not healthy after migrating")
		}
		return waitHTTP(ctx, url, timeout, alive)
	}
	startErr := sFail.Start(ctx)
	if startErr == nil {
		t.Fatal("the start succeeded despite a failing api health gate")
	}
	snaps2 := snapshotFiles(t, data)
	if len(snaps2) != 2 {
		t.Fatalf("expected a second snapshot from the failed update, got %v", snaps2)
	}
	newest := newestOf(t, snaps2)
	if !strings.Contains(startErr.Error(), filepath.Base(newest)) {
		t.Errorf("the failure does not name the snapshot it restored (%s):\n%v", filepath.Base(newest), startErr)
	}
	if !strings.Contains(startErr.Error(), "rolled back") {
		t.Errorf("the failure does not say the database was rolled back:\n%v", startErr)
	}
	stopNow(t, sFail)
	for _, name := range []string{services.API, services.PowerSync, services.Caddy} {
		if sFail.serviceRunning(name) {
			t.Errorf("%s is still running after a failed update", name)
		}
	}

	// ── phase 4: the person re-installs the previous DMG ────────────────────────
	//
	// The half the runtime cannot do for them, and the one nothing has tested: a full
	// stack — PowerSync's storage database and replication slot included — starting on a
	// database that rollbackTo replaced under it.
	t.Log("phase 4: start A again on the rolled-back data, as a re-install would")
	before := snapshotFiles(t, data)
	sA2 := newSupervisorOn(t, bundleA, data)
	if err := sA2.Start(ctx); err != nil {
		t.Fatalf("re-installing the previous version did not come up on the restored data: %v", err)
	}
	if got := scalar(t, ctx, sA2, db, "select note from update_canary"); got != canary {
		t.Errorf("canary = %q, want %q — the rollback did not restore the household's data", got, canary)
	}
	if got := scalar(t, ctx, sA2, db, "select to_regclass('public.update_probe') is not null"); got != "f" {
		t.Error("update_probe still exists — the snapshot was taken after the migration, not before it")
	}
	if after := snapshotFiles(t, data); len(after) != len(before) {
		t.Errorf("going back to A took a snapshot (%v → %v); nothing was pending, so nothing was at risk",
			before, after)
	}
	for _, name := range []string{services.API, services.PowerSync, services.Caddy} {
		if !sA2.serviceRunning(name) {
			t.Errorf("%s is not running after re-installing the previous version", name)
		}
	}
	stopNow(t, sA2)

	// ── phase 5: the update sticks, and then someone goes back anyway ───────────
	t.Log("phase 5: update to B for real, then try to start A on it — the downgrade guard")
	sB2 := newSupervisorOn(t, bundleB, data)
	if err := sB2.Start(ctx); err != nil {
		t.Fatalf("the second update to B failed: %v", err)
	}
	stopNow(t, sB2)
	beforeRefusal := snapshotFiles(t, data)

	sA3 := newSupervisorOn(t, bundleA, data)
	refusal := sA3.Start(ctx)
	if refusal == nil {
		t.Fatal("bundle A started against a schema only B ships — the guard did not fire")
	}
	t.Logf("the downgrade guard says:\n%v", refusal)
	for _, want := range []string{
		versionB,                  // the version that wrote the data
		versionA,                  // the version refusing
		probeMigration,            // the migration A does not have
		"re-install",              // way out 1
		"waffled-runtime restore", // way out 2
		"--yes",
	} {
		if !strings.Contains(refusal.Error(), want) {
			t.Errorf("the refusal does not mention %q:\n%v", want, refusal)
		}
	}
	// It has to name a file that exists and that A could really restore.
	named := namedSnapshotIn(refusal.Error(), beforeRefusal)
	if named == "" {
		t.Errorf("the refusal names no snapshot from %v", beforeRefusal)
	} else if side, ok := backup.ReadSidecar(named); !ok {
		t.Errorf("the refusal names %s, which has no sidecar to vouch for it", named)
	} else if err := backup.CheckRestorable(side.Migration, backup.Level(bundleMigrationsOf(t, bundleA))); err != nil {
		t.Errorf("the refusal recommends a snapshot this build would then refuse to restore: %v", err)
	}
	// Refused before anything that writes.
	for _, name := range []string{services.API, services.PowerSync, services.Caddy} {
		if sA3.serviceRunning(name) {
			t.Errorf("%s is running after a refused start", name)
		}
	}
	// And the backups directory is exactly as it was — retention lives downstream of the
	// guard, which matters because the file the refusal just recommended is in there.
	if after := snapshotFiles(t, data); strings.Join(after, "\n") != strings.Join(beforeRefusal, "\n") {
		t.Errorf("a refused start changed the backups directory:\nbefore %v\nafter  %v", beforeRefusal, after)
	}
	stopNow(t, sA3)

	t.Logf("the whole update loop took %s", time.Since(started).Round(time.Second))
}

// newSupervisorOn builds a Supervisor over one bundle and data dir, and guarantees it is
// stopped when the test ends however it ends — a leftover postmaster would collide with
// the next phase.
func newSupervisorOn(t *testing.T, bundle, data string) *Supervisor {
	t.Helper()
	s, err := New(Options{BundleDir: bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatalf("supervisor.New on %s: %v", filepath.Base(bundle), err)
	}
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s.Stop(stopCtx)
	})
	return s
}

func stopNow(t *testing.T, s *Supervisor) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := s.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func scalar(t *testing.T, ctx context.Context, s *Supervisor, db, q string) string {
	t.Helper()
	stop, err := s.ensurePostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	out, err := s.QueryScalar(ctx, db, q)
	if err != nil {
		t.Fatalf("query %q: %v", q, err)
	}
	return strings.TrimSpace(out)
}

func newestOf(t *testing.T, paths []string) string {
	t.Helper()
	newest, at := "", time.Time{}
	for _, p := range paths {
		stamp, ok := backup.StampOf(filepath.Base(p))
		if !ok {
			t.Fatalf("%s has a name StampOf cannot read", p)
		}
		if newest == "" || stamp.After(at) {
			newest, at = p, stamp
		}
	}
	return newest
}

// namedSnapshotIn returns whichever of these files the message mentions.
func namedSnapshotIn(msg string, candidates []string) string {
	for _, c := range candidates {
		if strings.Contains(msg, filepath.Base(c)) {
			return c
		}
	}
	return ""
}

func bundleVersionOf(t *testing.T, dir string) string {
	t.Helper()
	m, err := manifest.Load(dir)
	if err != nil {
		t.Fatalf("read the manifest of %s: %v", dir, err)
	}
	return m.WaffledVersion
}

func bundleMigrationsOf(t *testing.T, dir string) []string {
	t.Helper()
	m, err := manifest.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	names, err := backup.MigrationNamesInDir(backup.MigrationsDir(dir, m.Components.API.Migrations))
	if err != nil {
		t.Fatal(err)
	}
	return names
}

// deriveNewerBundle builds bundle B from the real bundle A: same 662 MB of binaries, a
// bumped version, and one extra migration.
//
// APFS clones it (`cp -c`) rather than copying: the whole tree is shared with A until a
// file is written, so this costs metadata rather than 662 MB and a minute. `-c` is not
// available on every filesystem, so a failure falls back to a real copy and says which
// happened — CI runs this on a macos-15 runner whose volume layout is not this Mac's.
//
// The manifest is patched through map[string]any so that component keys this Go struct
// does not model survive; re-marshalling through manifest.Manifest would quietly drop
// them and leave a bundle that verifies but has lost information.
func deriveNewerBundle(t *testing.T, src string) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "Application Support", "runtime B")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}

	cloneStarted := time.Now()
	if out, err := exec.Command("/bin/cp", "-c", "-R", src, dst).CombinedOutput(); err != nil {
		t.Logf("APFS clone unavailable (%v: %s); falling back to a real copy", err, strings.TrimSpace(string(out)))
		_ = os.RemoveAll(dst)
		if out, err := exec.Command("/bin/cp", "-R", src, dst).CombinedOutput(); err != nil {
			t.Fatalf("copy the bundle: %v\n%s", err, out)
		}
	}
	t.Logf("bundle B cloned in %s", time.Since(cloneStarted).Round(time.Millisecond))

	m, err := manifest.Load(dst)
	if err != nil {
		t.Fatal(err)
	}
	migration := filepath.Join(backup.MigrationsDir(dst, m.Components.API.Migrations), probeMigration+".sql")
	if err := os.WriteFile(migration, []byte(probeSQL), 0o644); err != nil {
		t.Fatal(err)
	}

	// Whatever this bundle claims, B claims one more — a real update's version bump.
	raw, err := os.ReadFile(filepath.Join(dst, manifest.FileName))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["waffledVersion"] = m.WaffledVersion + "+test.1"

	// Re-scan rather than hand-patching one entry: the manifest is what the runtime
	// refuses to start without, and a test that hand-maintains it would eventually
	// diverge from what Scan computes and fail as something else entirely.
	files, symlinks, err := manifest.Scan(dst)
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, f := range files {
		total += f.Size
	}
	doc["files"], doc["symlinks"] = files, symlinks
	doc["fileCount"], doc["symlinkCount"], doc["totalBytes"] = len(files), len(symlinks), total

	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, manifest.FileName), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := manifest.Verify(dst); err != nil {
		t.Fatalf("bundle B does not verify against its own manifest — the runtime would refuse it: %v", err)
	}
	return dst
}
