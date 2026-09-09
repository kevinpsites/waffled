//go:build integration

// The downgrade guard, against the real bundle.
//
// The state it protects against is reachable in one move: a person whose update went
// wrong re-installs the previous DMG. Their data has already been migrated by the newer
// build, and migrations only run forward — so the older build must refuse rather than
// serve a schema its code does not know, and must say what to do about it.
//
// Faking the "newer" half with a single pgmigrations row rather than a second bundle is
// deliberate here: this test is about the guard and its message, and it costs one start.
// update_integration_test.go proves the same guard across two genuinely different bundles.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration ./internal/supervisor/
package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

func TestStartRefusesADatabaseMigratedByANewerBuild(t *testing.T) {
	s, data := integrationSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s.Stop(stopCtx)
	})

	if err := s.Start(ctx); err != nil {
		t.Fatalf("first start: %v", err)
	}
	db := s.plan.Env.PostgresDB()
	stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
	if err := s.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	c()

	// A snapshot this build CAN serve, of the kind the update that went wrong would have
	// left behind. Only its sidecar is read here — what makes a file recommendable is the
	// migration level recorded beside it, not its contents.
	bundled, err := s.bundleMigrations()
	if err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(s.plan.Layout.Backups,
		backup.SnapshotName("0.14.3", "9.9.9", time.Now().Add(-time.Hour)))
	if err := os.WriteFile(snapshot, []byte("pretend snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := backup.WriteSidecar(snapshot, backup.Sidecar{
		Migration: backup.Level(bundled), TakenAt: "2026-09-05T03:00:00Z",
		FromVersion: "0.14.3", ToVersion: "9.9.9",
	}); err != nil {
		t.Fatal(err)
	}
	before := snapshotFiles(t, data)

	// The newer build's mark: one migration this bundle does not ship. A row is all a
	// newer Waffled would leave in pgmigrations, and it is what the guard reads.
	s2, err := New(Options{BundleDir: s.plan.Bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	pgStop, err := s2.ensurePostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s2.QueryScalar(ctx, db,
		"insert into pgmigrations (name, run_on) values ('9999_from_the_future', now())"); err != nil {
		t.Fatalf("pretend a newer build migrated this database: %v", err)
	}
	pgStop()

	s3, err := New(Options{BundleDir: s.plan.Bundle, DataDir: data, Log: NewLogger(&tw{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s3.Stop(stopCtx)
	})

	startErr := s3.Start(ctx)
	if startErr == nil {
		t.Fatal("the start succeeded against a database holding a migration this build does not ship")
	}
	t.Logf("the guard says:\n%v", startErr)

	for _, want := range []string{
		"newer", "9999_from_the_future", "re-install",
		"waffled-runtime restore", "--yes", filepath.Base(snapshot),
	} {
		if !strings.Contains(startErr.Error(), want) {
			t.Errorf("the refusal does not mention %q:\n%v", want, startErr)
		}
	}

	// It refuses BEFORE the things that would change the data. The api is what proves it:
	// reaching the api means migrate ran, and migrate against a schema from a newer build
	// is the failure this exists to prevent.
	for _, name := range []string{services.API, services.PowerSync, services.Caddy} {
		if s3.serviceRunning(name) {
			t.Errorf("%s is running after a refused start — the guard let the sequence get past it", name)
		}
	}

	// Nothing was snapshotted and nothing was pruned. Retention lives inside
	// snapshotBeforeMigrate and Backup, both downstream of the guard, so a refused start
	// must leave the backups directory exactly as it found it — which matters because the
	// file it just recommended is in there.
	after := snapshotFiles(t, data)
	if strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Errorf("the backups directory changed during a refused start:\nbefore %v\nafter  %v", before, after)
	}

	// And `doctor` says the same thing, with the stack down — which is the only state
	// anyone will ever run it in here, because the start it is asking about did not come
	// up. A check that needed a running server would be dead code in exactly this case.
	//
	// The stop is what RunForeground does after a failed start, so this is the state a
	// person actually meets: nothing running, and a question about why.
	stopCtx2, c2 := context.WithTimeout(context.Background(), 3*time.Minute)
	if err := s3.Stop(stopCtx2); err != nil {
		t.Fatalf("stop after the refused start: %v", err)
	}
	c2()
	if _, running := s3.postgresPid(); running {
		t.Fatal("postgres is still up; this half of the test needs it down")
	}

	checks := s3.Doctor(ctx)

	var found *Check
	for _, c := range checks {
		if strings.Contains(c.Detail, "9999_from_the_future") {
			found = &c
			break
		}
	}
	if found == nil {
		t.Fatal("doctor does not report the schema the start refused to serve")
	}
	if found.Status != CheckFail {
		t.Errorf("doctor reports the downgrade as %q, want %q", found.Status, CheckFail)
	}

	// And it answers the REST of its Postgres questions in the same breath. The schema
	// check starts a postmaster of its own when the stack is down; it used to run above
	// the "postgres is running" gate, which then bailed — so the one command someone runs
	// precisely BECAUSE their server will not start reported fewer diagnostics than the
	// one they run when it is up, having paid for the Postgres start either way. One
	// temporary postmaster now serves all of them.
	byName := map[string]Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	for _, want := range []string{"database schema", "postgres connection", "wal_level", "collation"} {
		c, ok := byName[want]
		if !ok {
			t.Errorf("doctor on a stopped install does not report %q at all", want)
			continue
		}
		// "could not …" is how every one of these reports a question it was unable to
		// ask — which, with a postmaster up, means something is genuinely wrong rather
		// than merely stopped.
		if strings.Contains(c.Detail, "could not") {
			t.Errorf("%q went unanswered with the stack down: %s", want, c.Detail)
		}
	}

	if _, running := s3.postgresPid(); running {
		t.Error("doctor left postgres running after starting it for itself")
	}
}
