//go:build integration

// Backup and restore, end to end against the real bundle.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration ./...
package runtime_test

import (
	"compress/gzip"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

// TestBackupAndRestoreRoundTrip is the promise the whole feature makes: a household that
// loses data gets it back, and the server works afterwards — including PowerSync, which
// has to rebuild its buckets from data it has never seen before.
//
// start → write a row → back up → destroy the row → restore → the row is back, every
// service is green again, and PowerSync's replication is live rather than merely
// answering its liveness probe from a stale slot.
func TestBackupAndRestoreRoundTrip(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
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
	db := s.Plan().Env.PostgresDB()

	// A row of our own, so the assertion is about data surviving rather than about the
	// schema being recreated.
	const canary = "the-jones-family"
	if _, err := s.QueryScalar(ctx, db,
		"create table if not exists restore_probe (note text); "+
			"insert into restore_probe values ('"+canary+"')"); err != nil {
		t.Fatalf("write the canary row: %v", err)
	}

	// ── back up, with the stack running (pg_dump is online) ─────────────────────
	dump, err := s.Backup(ctx, supervisor.BackupOptions{})
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if !backup.IsDump(dump) {
		t.Errorf("the dump is not named as a routine backup: %s", dump)
	}
	if fi, err := os.Stat(dump); err != nil || fi.Size() == 0 {
		t.Fatalf("the dump is missing or empty: %v", err)
	}

	// backup_runs is what Settings → System Health reads. The row has to be there, and
	// it has to be the shape the api's query expects.
	assertBackupRunRecorded(ctx, t, s, db, filepath.Base(dump))

	// The backups block in status --json, which the menu-bar app polls.
	report := s.Status(ctx)
	if report.Backups.LastPath != dump {
		t.Errorf("status backups.lastPath = %q, want %q", report.Backups.LastPath, dump)
	}
	if report.Backups.Count != 1 || report.Backups.LastError != "" {
		t.Errorf("status backups block is wrong: %+v", report.Backups)
	}
	if report.Backups.LastMigration == "" {
		t.Error("status does not report the migration level of the last backup")
	}

	// ── destroy the data ────────────────────────────────────────────────────────
	if _, err := s.QueryScalar(ctx, db, "delete from restore_probe"); err != nil {
		t.Fatalf("delete the canary row: %v", err)
	}
	if got, _ := s.QueryScalar(ctx, db, "select count(*) from restore_probe"); strings.TrimSpace(got) != "0" {
		t.Fatalf("the canary row was not deleted (count %q); the restore would prove nothing", got)
	}

	// ── restore ─────────────────────────────────────────────────────────────────
	if err := s.Restore(ctx, supervisor.RestoreOptions{File: dump, Yes: true}); err != nil {
		dumpLogs(t, data)
		t.Fatalf("restore: %v", err)
	}
	// Restore leaves the stack down with Postgres up; the caller brings it back, which is
	// what re-runs migrations and lets 00-init.sql recreate powersync_storage.
	if err := s.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("start after restore: %v", err)
	}

	got, err := s.QueryScalar(ctx, db, "select note from restore_probe")
	if err != nil {
		t.Fatalf("read the canary row back: %v", err)
	}
	if strings.TrimSpace(got) != canary {
		t.Errorf("canary = %q, want %q — the restore did not bring the data back",
			strings.TrimSpace(got), canary)
	}

	// ── everything is green again ───────────────────────────────────────────────
	after := s.Status(ctx)
	if after.State != status.StateRunning {
		t.Errorf("after the restore the stack is %q:\n%s", after.State, after.Text())
	}
	ports := s.Plan().Ports
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", ports.Public), 200)
	assertStatusIn(t, fmt.Sprintf("http://127.0.0.1:%d/api/health", ports.Public), 200, 401)
	assertStatus(t, fmt.Sprintf("http://127.0.0.1:%d/probes/liveness", ports.PowerSyncPublic), 200)

	// PowerSync's liveness would answer even if replication were dead, so assert the
	// thing that actually had to be rebuilt: a fresh logical slot on the restored
	// database. Without dropping the old one, PowerSync would resume from a WAL position
	// that no longer describes this data and sync silently nothing.
	assertReplicationSlotRebuilt(ctx, t, s, db)
}

// TestRestoreAcceptsACompoSidecarDump is the Docker-to-Mac migration path, and the only
// test that exercises the plain-SQL restore at all.
//
// The file is produced with the Compose backup sidecar's exact invocation —
// `pg_dump --clean --if-exists --no-owner --no-privileges | gzip` into
// waffled-<stamp>.sql.gz — because the interesting question is not whether our own code
// round-trips but whether the file a family actually carries over restores. Those dumps
// carry their own DROPs, land in a freshly created empty database, and go in through
// psql with ON_ERROR_STOP=1 and --single-transaction: a combination that either works on
// the real thing or does not.
func TestRestoreAcceptsAComposeSidecarDump(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
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
	db := s.Plan().Env.PostgresDB()

	const canary = "carried-over-from-docker"
	if _, err := s.QueryScalar(ctx, db,
		"create table if not exists compose_probe (note text); "+
			"insert into compose_probe values ('"+canary+"')"); err != nil {
		t.Fatalf("write the canary row: %v", err)
	}

	dump := writeComposeStyleDump(ctx, t, s, db, filepath.Join(data, "backups"))
	// It must be recognised as the sidecar's format, not ours.
	if got := backup.FormatOf(dump); got != backup.FormatPlainGzip {
		t.Fatalf("FormatOf(%s) = %v, want gzipped plain SQL", dump, got)
	}
	// And it has no sidecar JSON, so the level has to come out of the gzip stream —
	// the fallback that exists for precisely this file.
	if _, ok := backup.ReadSidecar(dump); ok {
		t.Fatal("the fixture unexpectedly has a sidecar; this test is about dumps without one")
	}

	if _, err := s.QueryScalar(ctx, db, "delete from compose_probe"); err != nil {
		t.Fatalf("delete the canary row: %v", err)
	}

	if err := s.Restore(ctx, supervisor.RestoreOptions{File: dump, Yes: true}); err != nil {
		dumpLogs(t, data)
		t.Fatalf("restoring a Compose sidecar dump: %v", err)
	}
	if err := s.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("start after restore: %v", err)
	}

	got, err := s.QueryScalar(ctx, db, "select note from compose_probe")
	if err != nil {
		t.Fatalf("read the canary row back: %v", err)
	}
	if strings.TrimSpace(got) != canary {
		t.Errorf("canary = %q, want %q", strings.TrimSpace(got), canary)
	}
	if after := s.Status(ctx); after.State != status.StateRunning {
		t.Errorf("after restoring a plain dump the stack is %q:\n%s", after.State, after.Text())
	}
}

// writeComposeStyleDump produces the file infra/compose/backup/backup.sh would: plain
// SQL with --clean --if-exists --no-owner --no-privileges, gzipped, named
// waffled-<UTC stamp>.sql.gz.
func writeComposeStyleDump(ctx context.Context, t *testing.T, s *supervisor.Supervisor, db, dir string) string {
	t.Helper()
	plan := s.Plan()
	out := filepath.Join(dir, "waffled-"+time.Now().UTC().Format("20060102-150405")+".sql.gz")

	cmd := exec.CommandContext(ctx, plan.PostgresBin("pg_dump"),
		"-h", "127.0.0.1",
		"-p", fmt.Sprint(plan.Ports.Postgres),
		"-U", plan.Env.PostgresUser(),
		"-d", db,
		"--clean", "--if-exists", "--no-owner", "--no-privileges",
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+plan.Env.Get("POSTGRES_PASSWORD"))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	sql, err := cmd.Output()
	if err != nil {
		t.Fatalf("pg_dump (compose flags): %v\n%s", err, stderr.String())
	}

	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	if _, err := gz.Write(sql); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote a Compose-style dump: %s (%d bytes of SQL)", out, len(sql))
	return out
}

// TestRestoreRefusesADumpNewerThanTheBundle pins the one unrecoverable direction:
// migrations only run forward, so a database ahead of the code has no way back.
func TestRestoreRefusesADumpNewerThanTheBundle(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		_ = s.Stop(stopCtx)
		killLeftovers(t, data)
	})
	if err := s.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}

	dump, err := s.Backup(ctx, supervisor.BackupOptions{})
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	// Claim, in the sidecar, that this dump came from a far newer Waffled. The sidecar is
	// exactly how a real dump from a newer build would announce itself.
	side, ok := backup.ReadSidecar(dump)
	if !ok {
		t.Fatal("no sidecar to rewrite")
	}
	side.Migration = "9999_from_the_future"
	if err := backup.WriteSidecar(dump, side); err != nil {
		t.Fatal(err)
	}

	err = s.Restore(ctx, supervisor.RestoreOptions{File: dump, Yes: true})
	if err == nil {
		t.Fatal("a dump newer than the bundle was restored; it must be refused")
	}
	if !strings.Contains(err.Error(), "9999_from_the_future") {
		t.Errorf("the refusal should name the migration this build lacks: %v", err)
	}

	// And refusing must not have taken the server down: the check happens before
	// anything is stopped, precisely so a household does not lose a running server to a
	// restore that was never going to be allowed.
	if report := s.Status(ctx); report.State != status.StateRunning {
		t.Errorf("the refused restore stopped the stack (%s):\n%s", report.State, report.Text())
	}
}

// TestRestoreRefusesWithoutConfirmation: this is the one command that destroys data, so
// the absence of both --yes and a terminal must stop it.
func TestRestoreRefusesWithoutConfirmation(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		_ = s.Stop(stopCtx)
		killLeftovers(t, data)
	})
	if err := s.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	dump, err := s.Backup(ctx, supervisor.BackupOptions{})
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	err = s.Restore(ctx, supervisor.RestoreOptions{File: dump}) // no Yes, no Confirm
	if err == nil {
		t.Fatal("restore proceeded with no confirmation and no --yes")
	}
	if !strings.Contains(err.Error(), "--yes") {
		t.Errorf("the refusal should say how to confirm: %v", err)
	}

	// A confirmation that is refused must also stop it, without stopping the server.
	err = s.Restore(ctx, supervisor.RestoreOptions{
		File:    dump,
		Confirm: func(string) bool { return false },
	})
	if err == nil {
		t.Fatal("restore proceeded after the confirmation was declined")
	}
	if report := s.Status(ctx); report.State != status.StateRunning {
		t.Errorf("a declined restore stopped the stack:\n%s", report.Text())
	}
}

// TestRetentionKeepsTheLastNAndLeavesSnapshotsAlone drives the pruner through the real
// Backup path rather than a fixture directory, because the bug worth catching is the two
// pools sharing a directory.
func TestRetentionKeepsTheLastNAndLeavesSnapshotsAlone(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		_ = s.Stop(stopCtx)
		killLeftovers(t, data)
	})
	if err := s.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	backupsDir := s.Plan().Layout.Backups

	// A snapshot sitting in the same directory, of the kind a previous upgrade left.
	snapshot := filepath.Join(backupsDir, backup.SnapshotName("0.14.2", time.Now()))
	if err := os.WriteFile(snapshot, []byte("pretend snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Three backups, keeping two. Names carry a one-second resolution timestamp, so the
	// runs are spaced to keep them distinct and orderable.
	var dumps []string
	for i := 0; i < 3; i++ {
		if i > 0 {
			time.Sleep(1100 * time.Millisecond)
		}
		d, err := s.Backup(ctx, supervisor.BackupOptions{Keep: 2})
		if err != nil {
			t.Fatalf("backup %d: %v", i, err)
		}
		dumps = append(dumps, d)
	}

	if _, err := os.Stat(dumps[0]); err == nil {
		t.Errorf("the oldest backup was not pruned: %s", dumps[0])
	}
	for _, d := range dumps[1:] {
		if _, err := os.Stat(d); err != nil {
			t.Errorf("a backup inside the retention window was pruned: %s", d)
		}
	}
	// The point of the test: retention on one pool must not touch the other.
	if _, err := os.Stat(snapshot); err != nil {
		t.Errorf("backup retention deleted a pre-migration snapshot: %s", snapshot)
	}
	// A pruned dump must take its sidecar with it, not orphan it.
	if _, err := os.Stat(dumps[0] + backup.SidecarExt); err == nil {
		t.Errorf("the pruned backup left its sidecar behind: %s", dumps[0]+backup.SidecarExt)
	}
}

// assertBackupRunRecorded checks the row the api's health check will read — the same
// query, so a column or status string that drifted shows up here rather than as a silent
// blank in Settings → System Health.
func assertBackupRunRecorded(ctx context.Context, t *testing.T, s *supervisor.Supervisor, db, file string) {
	t.Helper()
	out, err := s.QueryScalar(ctx, db,
		`select status || '|' || coalesce(file_name,'') || '|' || coalesce(size_bytes,0)::text
		   from backup_runs
		  where status in ('success','failed')
		  order by finished_at desc nulls last
		  limit 1`)
	if err != nil {
		t.Fatalf("read backup_runs: %v", err)
	}
	fields := strings.Split(strings.TrimSpace(out), "|")
	if len(fields) != 3 {
		t.Fatalf("unexpected backup_runs row %q", out)
	}
	if fields[0] != "success" {
		t.Errorf("backup_runs status = %q, want success", fields[0])
	}
	if fields[1] != file {
		t.Errorf("backup_runs file_name = %q, want %q", fields[1], file)
	}
	if fields[2] == "0" || fields[2] == "" {
		t.Errorf("backup_runs size_bytes = %q, want the size of the dump", fields[2])
	}

	// No 'running' row may be left dangling: the api ignores those, so a leak would be
	// invisible until someone looked at the table directly.
	stuck, err := s.QueryScalar(ctx, db, "select count(*) from backup_runs where status = 'running'")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(stuck) != "0" {
		t.Errorf("%s backup_runs rows are still 'running' after the backup finished", stuck)
	}
}

// assertReplicationSlotRebuilt proves PowerSync is replicating the RESTORED database,
// not resuming from the slot it held before. Liveness alone would not catch that: the
// service answers its probe perfectly well while syncing nothing.
func assertReplicationSlotRebuilt(ctx context.Context, t *testing.T, s *supervisor.Supervisor, db string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for {
		out, err := s.QueryScalar(ctx, "postgres",
			"select count(*) from pg_replication_slots where database = '"+db+"' and active")
		if err == nil && strings.TrimSpace(out) != "0" {
			return
		}
		if time.Now().After(deadline) {
			all, _ := s.QueryScalar(ctx, "postgres",
				"select slot_name || ' active=' || active from pg_replication_slots")
			t.Errorf("PowerSync has no active replication slot on the restored database — "+
				"its buckets were not rebuilt. Slots: %q", strings.TrimSpace(all))
			return
		}
		time.Sleep(2 * time.Second)
	}
}
