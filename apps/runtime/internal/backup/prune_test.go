package backup

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// touch writes a placeholder dump (and its sidecar) so the pruner has something real to
// delete. Content is irrelevant; existence and name are what it decides on.
func touch(t *testing.T, dir, name string, withSidecar bool) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("dump"), 0o600); err != nil {
		t.Fatal(err)
	}
	if withSidecar {
		if err := os.WriteFile(filepath.Join(dir, name+SidecarExt), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// The two pools share one directory. Pruning routine dumps must not touch snapshots —
// a pruner that globbed "*.dump" would silently eat the rollback points.
func TestPruneKeepsTheTwoPoolsApart(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		"waffled-20260901-030000.dump",
		"waffled-20260902-030000.dump",
		"waffled-20260903-030000.dump",
	} {
		touch(t, dir, n, true)
	}
	for _, n := range []string{
		"pre-migrate-0.14.1-20260901-020000.dump",
		"pre-migrate-0.14.2-20260902-020000.dump",
	} {
		touch(t, dir, n, false)
	}

	removed, err := Prune(dir, KindDump, 2)
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if len(removed) != 1 || filepath.Base(removed[0]) != "waffled-20260901-030000.dump" {
		t.Fatalf("removed = %v, want just the oldest routine dump", removed)
	}

	got := names(t, dir)
	want := []string{
		"pre-migrate-0.14.1-20260901-020000.dump",
		"pre-migrate-0.14.2-20260902-020000.dump",
		"waffled-20260902-030000.dump",
		"waffled-20260902-030000.dump" + SidecarExt,
		"waffled-20260903-030000.dump",
		"waffled-20260903-030000.dump" + SidecarExt,
	}
	if len(got) != len(want) {
		t.Fatalf("after pruning:\n got %v\nwant %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("after pruning:\n got %v\nwant %v", got, want)
		}
	}
}

// Snapshot names begin with the version, so sorting them as strings puts 0.9.0 after
// 0.14.3 and prunes the newest rollback point. Ordering must come from the timestamp.
func TestPruneSnapshotsOrdersByTimeNotByVersionString(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		"pre-migrate-0.9.0-20260101-010000.dump",  // oldest, but sorts LAST as a string
		"pre-migrate-0.14.1-20260701-010000.dump", // middle
		"pre-migrate-0.14.2-20260801-010000.dump",
		"pre-migrate-0.14.3-20260901-010000.dump", // newest
	} {
		touch(t, dir, n, false)
	}

	removed, err := Prune(dir, KindSnapshot, 3)
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if len(removed) != 1 || filepath.Base(removed[0]) != "pre-migrate-0.9.0-20260101-010000.dump" {
		t.Fatalf("removed = %v, want the chronologically oldest snapshot (0.9.0)", removed)
	}
}

func TestPruneKeepsEverythingWhenUnderTheLimit(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "waffled-20260901-030000.dump", true)

	removed, err := Prune(dir, KindDump, 14)
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v, want nothing", removed)
	}
	if len(names(t, dir)) != 2 {
		t.Fatalf("the dump or its sidecar was removed: %v", names(t, dir))
	}
}

// A dump whose name has no readable stamp (renamed by hand) must not be silently
// deleted first just because it sorts oddly — fall back to its modification time.
func TestPruneFallsBackToModTimeForUnreadableNames(t *testing.T) {
	dir := t.TempDir()
	touch(t, dir, "waffled-20260903-030000.dump", false)
	touch(t, dir, "waffled-copy-of-something.dump", false)

	// Genuinely older than the stamped file's 2026-09-03, so "oldest" is unambiguous
	// without depending on what today happens to be.
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, "waffled-copy-of-something.dump"), old, old); err != nil {
		t.Fatal(err)
	}

	removed, err := Prune(dir, KindDump, 1)
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if len(removed) != 1 || filepath.Base(removed[0]) != "waffled-copy-of-something.dump" {
		t.Fatalf("removed = %v, want the file whose mtime is oldest", removed)
	}
}

func TestPruneOnAMissingDirectoryIsNotAnError(t *testing.T) {
	removed, err := Prune(filepath.Join(t.TempDir(), "nope"), KindDump, 3)
	if err != nil {
		t.Fatalf("Prune on a missing directory: %v", err)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v, want nothing", removed)
	}
}
