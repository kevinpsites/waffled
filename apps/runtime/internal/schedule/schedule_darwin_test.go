//go:build darwin

package schedule

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// plutil is macOS's own property-list parser — the same CoreFoundation code launchd uses
// to read a job file. Linting the generated plist with it is the only assertion that
// actually proves launchd would accept what we wrote; every string check in the portable
// test is a proxy for this one.
//
// It reads a temp file and never touches ~/Library/LaunchAgents.
func TestPlutilAcceptsTheGeneratedPlist(t *testing.T) {
	if _, err := os.Stat("/usr/bin/plutil"); err != nil {
		t.Skip("plutil is not available")
	}
	a, _ := newAgent(t)
	// A path that would break a hand-concatenated plist, to prove the escaping holds up
	// against the real parser rather than only against encoding/xml.
	a.DataDir = `/Users/sam & jo's Mac/Library/Application Support/Waffled`

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), Label+".plist")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}

	if out, err := exec.Command("/usr/bin/plutil", "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil rejected the generated plist: %v\n%s\n%s", err, out, body)
	}

	// Read the values back the way launchd would, so a key that lints but decodes to the
	// wrong type (RunAtLoad as the STRING "false", say — which is truthy) is caught.
	extract := func(keypath string) string {
		t.Helper()
		out, err := exec.Command("/usr/bin/plutil", "-extract", keypath, "raw", "-o", "-", path).CombinedOutput()
		if err != nil {
			t.Fatalf("plutil -extract %s: %v\n%s", keypath, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	if got := extract("Label"); got != Label {
		t.Errorf("Label decoded as %q, want %q", got, Label)
	}
	if got := extract("RunAtLoad"); got != "false" {
		t.Errorf("RunAtLoad decoded as %q, want false", got)
	}
	if got := extract("StartCalendarInterval.Hour"); got != "3" {
		t.Errorf("StartCalendarInterval.Hour decoded as %q, want 3", got)
	}
	if got := extract("StartCalendarInterval.Minute"); got != "0" {
		t.Errorf("StartCalendarInterval.Minute decoded as %q, want 0", got)
	}
	// The data directory must survive the round trip byte for byte, ampersand and all —
	// a mangled --data would back up the wrong directory, or none.
	if got := extract("ProgramArguments.5"); got != a.DataDir {
		t.Errorf("--data decoded as %q, want %q", got, a.DataDir)
	}
	if got := extract("ProgramArguments.1"); got != "backup" {
		t.Errorf("the job runs %q, want backup", got)
	}
}
