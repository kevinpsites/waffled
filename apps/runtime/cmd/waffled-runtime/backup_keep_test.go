package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
)

// A retention that keeps nothing is refused in its own words, before a bundle is looked
// for — the same place a mistyped --at is.
func TestBackupRefusesARetentionThatKeepsNothing(t *testing.T) {
	// Should the guard ever regress, this must not reach the real ~/Library/LaunchAgents.
	t.Setenv("HOME", t.TempDir())
	for _, keep := range []string{"0", "-3"} {
		err := run([]string{"backup", "--install-schedule", "--keep", keep})
		if err == nil {
			t.Errorf("--keep %s was accepted", keep)
			continue
		}
		if !strings.Contains(err.Error(), "--keep "+keep) {
			t.Errorf("--keep %s was refused without naming it: %v", keep, err)
		}
	}
}

// scheduleSandbox is an agent in a HOME nothing else uses, with a plist already installed
// the way an earlier Settings click would have left it.
func scheduleSandbox(t *testing.T, at string, keep int) *schedule.Agent {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return installedFor(t, filepath.Join(t.TempDir(), "Waffled"), at, keep, "")
}

// installedFor writes a plist backing up installedDir, then returns a fresh agent for
// agentDir ("" means the same directory) — the agent a re-install would build.
func installedFor(t *testing.T, installedDir, at string, keep int, agentDir string) *schedule.Agent {
	t.Helper()
	if agentDir == "" {
		agentDir = installedDir
	}
	installed, err := schedule.For("/x/waffled-runtime", "", installedDir, "")
	if err != nil {
		t.Fatal(err)
	}
	installed.At, installed.Keep = at, keep
	body, err := installed.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(installed.AgentsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installed.PlistPath(), body, 0o644); err != nil {
		t.Fatal(err)
	}
	fresh, err := schedule.For(installed.BinaryPath, "", agentDir, "")
	if err != nil {
		t.Fatal(err)
	}
	return fresh
}

// The label is global, so the plist on this Mac may be another household's — left
// behind when its folder was deleted, say. Its retention is not this household's: a
// fresh setup that kept the default would otherwise run nightly with someone else's 90
// while Settings said 14.
func TestReinstallingNeverInheritsAnotherHouseholdsRetention(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	a := installedFor(t, filepath.Join(t.TempDir(), "OldWaffled"), "01:00", 90,
		filepath.Join(t.TempDir(), "Waffled"))
	chooseSchedule(a, "03:00", 0)
	if a.Keep != 0 {
		t.Errorf("keep %d was taken from another household's schedule, want 0 (the default)", a.Keep)
	}
}

// Re-installing with only one of the two flags must leave the other alone. The Mac app
// changes the time without restating the retention, and an update re-asserting the
// schedule states neither — either way, a household's 30 must not quietly become 14.
func TestReinstallingKeepsWhateverWasNotRestated(t *testing.T) {
	for _, c := range []struct {
		name     string
		at       string
		keep     int
		wantAt   string
		wantKeep int
	}{
		{"neither flag", "", 0, "01:00", 30},
		{"only the time", "05:00", 0, "05:00", 30},
		{"only the retention", "", 7, "01:00", 7},
		{"both", "12:00", 90, "12:00", 90},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := scheduleSandbox(t, "01:00", 30)
			chooseSchedule(a, c.at, c.keep)
			if a.At != c.wantAt || a.Keep != c.wantKeep {
				t.Errorf("at %q keep %d, want at %q keep %d", a.At, a.Keep, c.wantAt, c.wantKeep)
			}
		})
	}
}
