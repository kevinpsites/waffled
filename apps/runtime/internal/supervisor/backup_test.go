package supervisor

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// backupSupervisor builds the least Supervisor that Backup can be driven through without
// a bundle or a database. PGDATA holds no cluster, so the dump fails early and for a
// reason that needs nothing running — which is exactly the shape this file needs: what
// happens on the way OUT of a failed backup.
func backupSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	// A run with no --keep asks the installed nightly schedule how many to keep, so HOME
	// points somewhere the real ~/Library/LaunchAgents can never be read from.
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	s := &Supervisor{
		log:   NewLogger(io.Discard, true),
		state: &rtstate.State{},
		plan:  services.Plan{Layout: datadir.At(root)},
	}
	if err := os.MkdirAll(s.plan.Layout.Backups, 0o700); err != nil {
		t.Fatal(err)
	}
	return s
}

// seedDumps writes n dump-shaped files, oldest first, and returns their paths.
func seedDumps(t *testing.T, dir string, n int) []string {
	t.Helper()
	var out []string
	at := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, backup.DumpName(at.Add(time.Duration(i)*24*time.Hour)))
		if err := os.WriteFile(p, []byte("not really a dump"), 0o600); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func dumpsIn(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if backup.IsDump(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out
}

// Retention must not be conditional on the dump succeeding.
//
// The failure it guards against is a full disk: pg_dump fails on ENOSPC, and if pruning
// only ever runs after a dump has landed, the one mechanism that frees space is never
// reached — so every following night fails identically, for good. Honouring `keep` is the
// contract whichever way the run ends.
func TestRetentionRunsEvenWhenTheDumpFails(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 5)

	if _, err := s.Backup(context.Background(), BackupOptions{Keep: 2}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail (there is no cluster)")
	}

	if got := dumpsIn(t, dir); len(got) != 2 {
		t.Errorf("%d dumps kept after a failed backup, want 2 — retention did not run, so a "+
			"disk that filled up can never free itself: %v", len(got), got)
	}
}

// The other half of the contract: retention deletes nothing it was not asked to. A failed
// run must never cost a household a backup that worked.
func TestRetentionKeepsEverythingWithinTheLimit(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 3)

	if _, err := s.Backup(context.Background(), BackupOptions{Keep: 14}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}

	if got := dumpsIn(t, dir); len(got) != 3 {
		t.Errorf("%d dumps left, want all 3 — a failed backup deleted a good one: %v", len(got), got)
	}
}

// Two backups must never run at once. The nightly launchd job and a "Back up now" click
// can land in the same second, and the dump name is only second-resolution: without a
// lock both runs compute the same `.part` path, one deletes the other's in-progress dump,
// and whichever renames first promotes a half-written file to the canonical backup name
// while status and doctor report it as healthy and current.
func TestBackupsAreSerialised(t *testing.T) {
	s := backupSupervisor(t)

	var mu sync.Mutex
	inside, maxInside := 0, 0
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			release, err := s.lockBackups(ctx, s.plan.Layout.Backups)
			if err != nil {
				t.Errorf("lockBackups: %v", err)
				return
			}
			defer release()
			mu.Lock()
			inside++
			if inside > maxInside {
				maxInside = inside
			}
			mu.Unlock()
			time.Sleep(150 * time.Millisecond)
			mu.Lock()
			inside--
			mu.Unlock()
		}()
	}
	wg.Wait()

	if maxInside != 1 {
		t.Errorf("%d backups held the lock at once, want 1", maxInside)
	}
}

// And the lock has to be around the whole of Backup, not merely available to it. Held
// from outside, Backup must wait rather than get as far as touching the dump files —
// so what it reports here is the wait giving up, never the failure that comes later.
func TestBackupWaitsForALockSomeoneElseHolds(t *testing.T) {
	s := backupSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	release, err := s.lockBackups(ctx, s.plan.Layout.Backups)
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer waitCancel()
	_, err = s.Backup(waitCtx, BackupOptions{})
	if err == nil {
		t.Fatal("a second backup ran while another held the lock")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("the second backup failed with %v, want the wait for the lock to time out — "+
			"anything else means it got past the lock", err)
	}
	// A backup that never started must not be recorded as one that failed: the nightly
	// job colliding with a manual click would otherwise turn System Health red.
	if d := backup.Describe(s.plan.Layout.Backups, false, ""); d.LastError != "" {
		t.Errorf("waiting for the lock was recorded as a backup failure: %q", d.LastError)
	}
}

// A dump the operator named is theirs: --out means their directory, their filenames, and
// retention has no business pruning it.
func TestRetentionSkipsAnOperatorNamedDestination(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 5)

	out := filepath.Join(t.TempDir(), "mine.dump")
	if _, err := s.Backup(context.Background(), BackupOptions{Out: out, Keep: 2}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}

	if got := dumpsIn(t, dir); len(got) != 5 {
		t.Errorf("%d dumps left, want 5 — retention pruned the backups directory during a "+
			"run that was writing somewhere else entirely: %v", len(got), got)
	}
}

// installSchedule writes the nightly agent's plist into the test's HOME — never loaded
// into launchd, which is all Backup reads: the file.
func installSchedule(t *testing.T, dataDir string, keep int) {
	t.Helper()
	a, err := schedule.For("/x/waffled-runtime", "", dataDir, "")
	if err != nil {
		t.Fatal(err)
	}
	a.Keep = keep
	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(a.AgentsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.PlistPath(), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

// "Back up now" and a `backup` typed in Terminal pass no --keep. They must keep what the
// household chose for the nightly one, or the first manual run prunes a 30-backup
// history back down to the default 14.
func TestAManualBackupKeepsWhatTheScheduleKeeps(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 20)
	installSchedule(t, s.plan.Layout.Root, 18)

	if _, err := s.Backup(context.Background(), BackupOptions{}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail (there is no cluster)")
	}
	if got := dumpsIn(t, dir); len(got) != 18 {
		t.Errorf("%d dumps kept, want the schedule's 18", len(got))
	}
}

// The launchd label is global: one Mac holds one nightly backup, and it may belong to a
// different data directory. Its retention is that household's, not this one's.
func TestAManualBackupIgnoresAnotherDataDirectorysSchedule(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 16)
	installSchedule(t, filepath.Join(t.TempDir(), "SomeoneElse"), 3)

	if _, err := s.Backup(context.Background(), BackupOptions{}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}
	if got := dumpsIn(t, dir); len(got) != backup.DefaultKeepDumps {
		t.Errorf("%d dumps kept, want the default %d — another household's schedule decided "+
			"this one's retention", len(got), backup.DefaultKeepDumps)
	}
}

// A --keep given on the command line is still the last word.
func TestAnExplicitKeepOutranksTheSchedule(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 10)
	installSchedule(t, s.plan.Layout.Root, 8)

	if _, err := s.Backup(context.Background(), BackupOptions{Keep: 4}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}
	if got := dumpsIn(t, dir); len(got) != 4 {
		t.Errorf("%d dumps kept, want the 4 asked for", len(got))
	}
}

// `status` reports the retention in force, so the Mac app's picker shows what the
// nightly job will actually do.
func TestStatusReportsTheRetentionInForce(t *testing.T) {
	s := backupSupervisor(t)
	if _, _, keep := s.scheduleFacts(); keep != backup.DefaultKeepDumps {
		t.Errorf("with no schedule, keep = %d, want the default %d", keep, backup.DefaultKeepDumps)
	}
	installSchedule(t, s.plan.Layout.Root, 30)
	if _, _, keep := s.scheduleFacts(); keep != 30 {
		t.Errorf("keep = %d, want the schedule's 30", keep)
	}
}
