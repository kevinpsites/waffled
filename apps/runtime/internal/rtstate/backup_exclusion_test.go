package rtstate

import (
	"path/filepath"
	"testing"
)

// The Time Machine exclusion is remembered so it is asserted once rather than on every
// invocation: `status` constructs a supervisor on every menu-bar poll, and shelling out
// to tmutil twice a second to re-ask a settled question would be a process per poll.
//
// It is recorded as a fact about this data directory, which is why it lives in
// runtime.json rather than being inferred — and why `doctor` still asks tmutil itself,
// so a directory restored onto a Mac that lost the xattr is reported rather than trusted.
func TestBackupExclusionIsRemembered(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")

	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if s.BackupExcluded {
		t.Fatal("a fresh state should not claim the exclusion is already set")
	}
	s.BackupExcluded = true
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}

	loaded, existed, err := Load(path)
	if err != nil || !existed {
		t.Fatalf("Load: %v (existed=%v)", err, existed)
	}
	if !loaded.BackupExcluded {
		t.Error("the exclusion flag did not survive a round trip through runtime.json")
	}
}

// An install created before this field existed must read as "not yet excluded", so the
// next start asserts it rather than assuming an old data directory is already protected.
func TestOlderRuntimeJSONReadsAsNotExcluded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := Save(path, s); err != nil {
		t.Fatal(err)
	}

	loaded, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.BackupExcluded {
		t.Error("a runtime.json without the field should report false, not true")
	}
}
