package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
)

// fakeBundle is the smallest tree that passes manifest verification. Arch and platform
// come from this machine: `Verify` refuses a bundle built for another, and the Go job
// runs on Linux.
func fakeBundle(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "waffled-runtime"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	files, symlinks, err := manifest.Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	m := manifest.Manifest{
		Schema: 1, Name: "waffled-runtime",
		Arch: runtime.GOARCH, Platform: runtime.GOOS,
		WaffledVersion: "0.0.0-test",
		FileCount:      len(files), SymlinkCount: len(symlinks),
		Files: files, Symlinks: symlinks,
	}
	raw, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, manifest.FileName), append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// Go's flag package stops parsing at the first non-flag word, so every command that takes
// a positional has to hoist its flags in front of it. `config set` and `move` did;
// `restore` and `logs` did not — and `restore` is the destructive one: it dropped
// `--data` and replaced whichever household the DEFAULT directory holds, reporting
// success either way.
func TestRestoreDoesNotIgnoreTheDataDirectoryAfterTheFilename(t *testing.T) {
	data := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "nope.dump")

	err := run([]string{"restore", missing, "--data", data, "--bundle", fakeBundle(t), "--yes"})
	if err == nil {
		t.Fatal("a dump that is not there must be refused")
	}
	// The refusal has to be about the file — proving the flags after it were read, and
	// that it never reached a default directory it was not pointed at.
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("want a refusal naming %q, got %v", missing, err)
	}
	if strings.Contains(err.Error(), "Application Support") {
		t.Errorf("--data after the filename was dropped and the default was used: %v", err)
	}
}

// `logs api --data DIR` has the same shape. Harmless by comparison — it reads rather than
// writes — but it read the wrong install and said nothing.
func TestLogsReadsTheDataDirectoryGivenAfterTheServiceName(t *testing.T) {
	data := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(filepath.Join(data, "logs"), 0o700); err != nil {
		t.Fatal(err)
	}
	want := "this is the log the flags pointed at"
	if err := os.WriteFile(filepath.Join(data, "logs", "api.log"), []byte(want+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := captureStdout(t, func() error {
		return run([]string{"logs", "api", "--data", data, "--bundle", fakeBundle(t), "-n", "5"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, want) {
		t.Errorf("the service name swallowed the flags after it, got %q", out)
	}
}
