package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
)

// fakeFollower stands in for *schedule.Agent. A real one cannot be used here: following
// a move re-installs the global launchd label, which would take over the nightly backup
// of whoever runs the suite.
type fakeFollower struct {
	to       string
	from     []string
	followed bool
	err      error
}

func (f *fakeFollower) Follow(from string) (bool, error) {
	f.from = append(f.from, from)
	return f.followed, f.err
}

func withFollower(t *testing.T, followed bool, err error) *fakeFollower {
	t.Helper()
	f := &fakeFollower{followed: followed, err: err}
	saved := newFollower
	newFollower = func(_ string, to datadir.Layout) (scheduleFollower, error) {
		f.to = to.Root
		return f, nil
	}
	t.Cleanup(func() { newFollower = saved })
	return f
}

// a household with one recognisable file in it, enough to prove the move carried it.
// No move test may reach a real schedule, so every one starts with a fake.
func movable(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	withFollower(t, false, nil)
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
	f := withFollower(t, true, nil)
	if err := run([]string{"move", "--to", filepath.Join(from, "inside"), "--data", from}); err == nil {
		t.Fatal("a destination inside the source must be refused")
	}
	if len(f.from) != 0 {
		t.Error("a refused move touched the nightly backup")
	}
}

// The nightly backup names its data directory, so a move that left it alone would back
// up a folder that is no longer there — recreating it empty — while the household went
// unprotected.
func TestMoveTakesTheNightlyBackupWithIt(t *testing.T) {
	from := movable(t)
	f := withFollower(t, true, nil)
	to := filepath.Join(t.TempDir(), "Waffled")

	out, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", to, "--data", from})
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.to != to || len(f.from) != 1 || f.from[0] != from {
		t.Errorf("followed from %v to %q, want from %q to %q", f.from, f.to, from, to)
	}
	if !strings.Contains(out, "nightly backup") {
		t.Errorf("the summary should say the nightly backup moved too, got %q", out)
	}
}

func TestMoveJSONStaysJSONWhenTheScheduleFollows(t *testing.T) {
	from := movable(t)
	withFollower(t, true, nil)
	out, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", filepath.Join(t.TempDir(), "Waffled"), "--data", from, "--json"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid([]byte(out)) {
		t.Errorf("--json printed more than json: %q", out)
	}
}

func TestADryRunLeavesTheNightlyBackupAlone(t *testing.T) {
	from := movable(t)
	f := withFollower(t, true, nil)
	if _, err := captureStdout(t, func() error {
		return run([]string{"move", "--to", filepath.Join(t.TempDir(), "Waffled"), "--data", from, "--dry-run"})
	}); err != nil {
		t.Fatal(err)
	}
	if len(f.from) != 0 {
		t.Error("a dry run touched the nightly backup")
	}
}

// The household is whole at the new address either way; a schedule that could not follow
// is said, not turned into a failed move the app would then report and retry.
func TestAScheduleThatCannotFollowDoesNotFailTheMove(t *testing.T) {
	from := movable(t)
	withFollower(t, false, errors.New("launchctl bootstrap: 5: Input/output error"))
	to := filepath.Join(t.TempDir(), "Waffled")
	stderr, err := moveQuietly(t, "--to", to, "--data", from)
	if err != nil {
		t.Fatalf("the move failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(to, "config.env")); err != nil {
		t.Errorf("config.env did not arrive: %v", err)
	}
	if !hasWarning(stderr, "nightly backup could not be pointed at") {
		t.Errorf("no `! ` warning line for the Mac app to show, stderr = %q", stderr)
	}
}

// The household is whole at the new address, so the move reports success — and the
// leftover is said, on the line the Mac app shows, rather than found on the next move.
func TestAnOldFolderThatWillNotGoIsSaidAndTheScheduleStillFollows(t *testing.T) {
	from := movable(t)
	f := withFollower(t, true, nil)
	parent := filepath.Dir(from)
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o700) })
	to := filepath.Join(t.TempDir(), "Waffled")

	stderr, err := moveQuietly(t, "--to", to, "--data", from)
	if err != nil {
		t.Fatalf("a move whose old folder stayed behind failed: %v", err)
	}
	if len(f.from) != 1 || f.from[0] != from {
		t.Errorf("the nightly backup was not followed from %q: %v", from, f.from)
	}
	if !hasWarning(stderr, "still there") {
		t.Errorf("no `! ` warning line about the old folder, stderr = %q", stderr)
	}
}

// moveQuietly runs `move`, dropping its summary, and returns what it said on stderr.
func moveQuietly(t *testing.T, args ...string) (string, error) {
	t.Helper()
	return captureStderr(t, func() error {
		_, err := captureStdout(t, func() error { return run(append([]string{"move"}, args...)) })
		return err
	})
}

// hasWarning is the Mac app's reading of stderr: a line that starts with "! ".
func hasWarning(stderr, containing string) bool {
	for _, line := range strings.Split(stderr, "\n") {
		if strings.HasPrefix(line, "! ") && strings.Contains(line, containing) {
			return true
		}
	}
	return false
}
