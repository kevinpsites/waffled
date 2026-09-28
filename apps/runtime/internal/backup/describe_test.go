package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The backups block in `status --json` is derived from the filesystem, never from the
// database: the question "when did it last back up?" is asked exactly when the stack is
// down, and status must still answer it.
func TestDescribeReadsTheNewestDumpOffDisk(t *testing.T) {
	dir := t.TempDir()
	body := []byte("a pretend custom-format dump")
	for _, n := range []string{"waffled-20260901-030000.dump", "waffled-20260903-030000.dump"} {
		if err := os.WriteFile(filepath.Join(dir, n), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A snapshot is newer than both, and must NOT be reported as the last backup: it is
	// a rollback point taken mid-upgrade, not a backup anyone can rely on.
	writeFile(t, dir, "pre-migrate-0.14.3-20260905-030000.dump")

	got := Describe(dir, false, "")
	if got.LastBackupAt != "2026-09-03T03:00:00Z" {
		t.Errorf("LastBackupAt = %q, want 2026-09-03T03:00:00Z", got.LastBackupAt)
	}
	if filepath.Base(got.LastPath) != "waffled-20260903-030000.dump" {
		t.Errorf("LastPath = %q, want the newest routine dump", got.LastPath)
	}
	if got.LastSizeBytes != int64(len(body)) {
		t.Errorf("LastSizeBytes = %d, want %d", got.LastSizeBytes, len(body))
	}
	if got.LastError != "" {
		t.Errorf("LastError = %q, want empty", got.LastError)
	}
	if got.ScheduleInstalled {
		t.Errorf("ScheduleInstalled = true, want false")
	}
	if got.Count != 2 {
		t.Errorf("Count = %d, want 2 routine dumps", got.Count)
	}
}

func TestDescribeOnAnEmptyDirectory(t *testing.T) {
	got := Describe(t.TempDir(), true, "")
	if got.LastBackupAt != "" || got.LastPath != "" || got.LastSizeBytes != 0 {
		t.Errorf("a directory with no dumps should report nothing: %+v", got)
	}
	if !got.ScheduleInstalled {
		t.Errorf("ScheduleInstalled should reflect what the caller was told")
	}
}

// A failed run leaves no dump behind, so the failure has to be recorded separately or
// status would show the last SUCCESS and call the situation fine.
func TestDescribeSurfacesTheLastFailure(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 9, 4, 3, 0, 0, 0, time.UTC)
	if err := RecordFailure(dir, at, "pg_dump: connection refused"); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}

	got := Describe(dir, false, "")
	if got.LastError != "pg_dump: connection refused" {
		t.Errorf("LastError = %q", got.LastError)
	}
	if got.LastErrorAt != "2026-09-04T03:00:00Z" {
		t.Errorf("LastErrorAt = %q", got.LastErrorAt)
	}

	// A later success clears it: leaving a week-old error next to a fresh backup reads
	// as "backups are broken" when they are not.
	if err := ClearFailure(dir); err != nil {
		t.Fatalf("ClearFailure: %v", err)
	}
	if e := Describe(dir, false, "").LastError; e != "" {
		t.Errorf("LastError = %q after a success, want empty", e)
	}
}

func TestSidecarRoundTrips(t *testing.T) {
	dir := t.TempDir()
	dump := filepath.Join(dir, "waffled-20260903-030000.dump")
	if err := os.WriteFile(dump, []byte("dump"), 0o600); err != nil {
		t.Fatal(err)
	}

	want := Sidecar{
		WaffledVersion: "0.14.3",
		GitSha:         "a506c352",
		Migration:      "0099_rhythms",
		Database:       "waffled",
		Collation:      "en_US.UTF-8",
		SizeBytes:      4,
		TakenAt:        "2026-09-03T03:00:00Z",
		// A snapshot's crossing, recorded beside it as well as in its name: the name is
		// what a person reads in a directory listing, the sidecar is what a program
		// reads without parsing filenames.
		FromVersion: "0.14.3",
		ToVersion:   "0.15.0",
	}
	if err := WriteSidecar(dump, want); err != nil {
		t.Fatalf("WriteSidecar: %v", err)
	}

	raw, err := os.ReadFile(dump + SidecarExt)
	if err != nil {
		t.Fatalf("the sidecar was not written beside the dump: %v", err)
	}
	var reparsed Sidecar
	if err := json.Unmarshal(raw, &reparsed); err != nil {
		t.Fatalf("the sidecar is not valid JSON: %v", err)
	}
	if reparsed != want {
		t.Errorf("sidecar round-trip:\n got %+v\nwant %+v", reparsed, want)
	}

	// The sidecar is how we know a dump's migration level without unpacking it.
	got, ok := ReadSidecar(dump)
	if !ok {
		t.Fatal("ReadSidecar could not find the sidecar it just wrote")
	}
	if got.Migration != want.Migration {
		t.Errorf("Migration = %q, want %q", got.Migration, want.Migration)
	}

	// A dump with no sidecar (one from the Docker sidecar, say) reports absence rather
	// than an error — restore falls back to reading the level out of the dump itself.
	if _, ok := ReadSidecar(filepath.Join(dir, "waffled-20260701-020000.sql.gz")); ok {
		t.Error("ReadSidecar claimed a sidecar exists for a Docker dump")
	}
}
