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

// Four files in this runtime are small JSON records written the same way — runtime.json,
// bonjour.json, a dump's sidecar and the backup failure note — and each had grown its own
// copy of marshal → append a newline → write. The copies had already started to drift,
// which is how one of them ends up with different crash semantics than its siblings.
func TestWriteJSONRoundTripsThroughAFileAPersonCanRead(t *testing.T) {
	type record struct {
		Name  string `json:"name"`
		Port  int    `json:"port"`
		Setup bool   `json:"setup"`
	}
	path := filepath.Join(t.TempDir(), "bonjour.json")
	want := record{Name: "The Seinfelds", Port: 8080}

	if err := WriteJSON(path, want, 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Indented and newline-terminated: these files are read in a terminal when something
	// has gone wrong, and `cat` should not leave the prompt mid-line.
	if !strings.Contains(string(raw), "\n  \"name\": \"The Seinfelds\"") {
		t.Errorf("not written for a person to read:\n%s", raw)
	}
	if !strings.HasSuffix(string(raw), "}\n") {
		t.Errorf("no trailing newline:\n%q", raw)
	}
	if st, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if st.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want the mode asked for", st.Mode().Perm())
	}

	var got record
	if err := ReadJSON(path, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("round trip gave %+v, want %+v", got, want)
	}
}

// Absence is a normal answer for every one of these files, and callers tell it apart from
// a corrupt one — a first run has no runtime.json, a stopped server has no bonjour.json.
func TestReadJSONDistinguishesAbsentFromUnreadable(t *testing.T) {
	dir := t.TempDir()
	var got struct{ Name string }

	err := ReadJSON(filepath.Join(dir, "absent.json"), &got)
	if !os.IsNotExist(err) {
		t.Errorf("a missing file gave %v, want something os.IsNotExist recognises", err)
	}

	corrupt := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corrupt, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ReadJSON(corrupt, &got); err == nil || os.IsNotExist(err) {
		t.Errorf("a corrupt file gave %v, want a decode error", err)
	}
}
