package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// a household with one recognisable file in it, enough to prove the move carried it.
func movable(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(filepath.Join(root, "media"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.env"), []byte("HTTP_PORT=8080\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "media", "photo.jpg"), []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestMoveTakesTheDataDirectoryToTheNewFolder(t *testing.T) {
	from := movable(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	out, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", to, "--data", from})
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(to, "media", "photo.jpg")); err != nil || string(got) != "jpeg" {
		t.Errorf("the media did not arrive: %q %v", got, err)
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Errorf("the old folder is still there: %v", err)
	}
	if !strings.Contains(out, to) {
		t.Errorf("the summary should name the new folder, got %q", out)
	}
}

// Go's flag package stops at the first non-flag argument, so the order a person types
// these in must not decide which directory gets moved.
func TestMoveReadsItsFlagsInEitherOrder(t *testing.T) {
	from := movable(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	if _, err := captureStdout(t, func() error {
		return run([]string{"move", "--data", from, "--to", to})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(to, "config.env")); err != nil {
		t.Errorf("config.env did not arrive: %v", err)
	}
}

func TestMoveNeedsSomewhereToMoveTo(t *testing.T) {
	from := movable(t)
	err := run([]string{"move", "--data", from})
	if err == nil {
		t.Fatal("a move with no destination must be refused")
	}
	if !strings.Contains(err.Error(), "--to") {
		t.Errorf("the error should name the missing flag, got %v", err)
	}
}

func TestMoveDryRunPrintsThePlanAndChangesNothing(t *testing.T) {
	from := movable(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	out, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", to, "--data", from, "--dry-run"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(from, "config.env")); err != nil {
		t.Errorf("a dry run moved something: %v", err)
	}
	if _, err := os.Stat(to); !os.IsNotExist(err) {
		t.Errorf("a dry run created %s", to)
	}
	if !strings.Contains(out, to) {
		t.Errorf("the plan should name where it would go, got %q", out)
	}
}

func TestMoveJSONIsTheShapeTheAppReads(t *testing.T) {
	from := movable(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	out, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", to, "--data", from, "--json"})
	})
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Bytes int64  `json:"bytes"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("--json did not print json: %v (%q)", err, out)
	}
	if got.To != to || got.From != from {
		t.Errorf("json = %+v, want a move from %q to %q", got, from, to)
	}
	if got.Bytes <= 0 {
		t.Errorf("bytes = %d, want the size it moved", got.Bytes)
	}
}

// The refusals belong to internal/relocate; this only checks one reaches the exit code,
// so a Mac app that shells out sees a failure rather than a cheerful zero.
func TestMoveReportsARefusal(t *testing.T) {
	from := movable(t)
	if err := run([]string{"move", "--to", filepath.Join(from, "inside"), "--data", from}); err == nil {
		t.Fatal("a destination inside the source must be refused")
	}
}
