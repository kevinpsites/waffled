package atomicfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteFileCreatesTheFileAtTheRequestedMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.env")

	if err := WriteFile(path, []byte("POSTGRES_PASSWORD=hunter2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "POSTGRES_PASSWORD=hunter2\n" {
		t.Errorf("wrote %q", body)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("mode is %o, want 600 — this file holds every secret", st.Mode().Perm())
	}
}

// Replacing an existing file must land the new content and re-assert the mode, even if
// the file on disk had been loosened.
func TestWriteFileReplacesAndTightensAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.env")
	if err := os.WriteFile(path, []byte("old\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}

	if err := WriteFile(path, []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	if string(body) != "new\n" {
		t.Errorf("wrote %q", body)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Errorf("mode is %o, want 600", st.Mode().Perm())
	}
}

// The temp file is an implementation detail; a successful write must not leave one in
// the data directory for an operator to wonder about.
func TestWriteFileLeavesNoTempBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	for i := 0; i < 3; i++ {
		if err := WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "runtime.json" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("directory holds %v, want only runtime.json", names)
	}
}

// A write into a directory that does not exist must fail loudly rather than silently
// leaving the old file in place.
func TestWriteFileReportsAnUnwritableDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "no-such-dir", "runtime.json")
	err := WriteFile(path, []byte("{}\n"), 0o644)
	if err == nil {
		t.Fatal("expected an error writing into a missing directory")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("the error should name the target path, got: %v", err)
	}
}
