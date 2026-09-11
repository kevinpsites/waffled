package schedule

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

const (
	oldFolder   = "/Users/sam/Library/Application Support/Waffled"
	movedFolder = "/Users/sam/Documents/Waffled"
)

// installedAs writes the plist an earlier install left behind, into a's LaunchAgents.
func installedAs(t *testing.T, a *Agent, dataDir, at string, keep int) []byte {
	t.Helper()
	earlier := *a
	earlier.DataDir, earlier.LogPath = dataDir, filepath.Join(dataDir, "logs", "backup.log")
	earlier.At, earlier.Keep = at, keep
	body, err := earlier.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.PlistPath(), body, 0o644); err != nil {
		t.Fatal(err)
	}
	return body
}

// followerFor is the agent `move` builds: the new folder, and whatever binary ran the move.
func followerFor(t *testing.T) (*Agent, *[][]string) {
	t.Helper()
	a, calls := newAgent(t)
	a.DataDir, a.LogPath = movedFolder, filepath.Join(movedFolder, "logs", "backup.log")
	a.BinaryPath, a.BundleDir = "/tmp/dev/waffled-runtime", ""
	return a, calls
}

func TestFollowPointsTheNightlyBackupAtTheMovedFolder(t *testing.T) {
	a, calls := followerFor(t)
	installed, _ := newAgent(t)
	installed.AgentsDir = a.AgentsDir
	installedAs(t, installed, oldFolder, "01:00", 30)

	// A trailing slash is the same folder.
	followed, err := a.Follow(oldFolder + "/")
	if err != nil || !followed {
		t.Fatalf("Follow = %v, %v; want it re-installed", followed, err)
	}
	if dir, _ := a.ScheduledDataDir(); dir != movedFolder {
		t.Errorf("the schedule backs up %q, want %q", dir, movedFolder)
	}
	if at, _ := a.ScheduledAt(); at != "01:00" {
		t.Errorf("the time became %q, want the 01:00 it was installed with", at)
	}
	if keep, _ := a.ScheduledKeep(); keep != 30 {
		t.Errorf("retention became %d, want the 30 it was installed with", keep)
	}
	raw, _ := os.ReadFile(a.PlistPath())
	args, err := programArguments(raw)
	if err != nil {
		t.Fatal(err)
	}
	// The binary and bundle it was installed with, not whichever binary ran the move.
	if args[0] != installed.BinaryPath || !contains(args, installed.BundleDir) {
		t.Errorf("program arguments %v, want the installed binary and bundle kept", args)
	}
	if !bytes.Contains(raw, []byte(filepath.Join(movedFolder, "logs", "backup.log"))) {
		t.Error("the backup log still points into the old folder")
	}
	if len(*calls) == 0 || (*calls)[len(*calls)-1][0] != "bootstrap" {
		t.Errorf("launchctl calls %v, want the job re-bootstrapped", *calls)
	}
}

// The label is global: the plist may be another household's, and a move of this one
// is not a reason to rewrite it.
func TestFollowLeavesAnotherHouseholdsScheduleAlone(t *testing.T) {
	a, calls := followerFor(t)
	before := installedAs(t, a, "/Users/jo/Waffled", "03:00", 14)

	followed, err := a.Follow(oldFolder)
	if err != nil || followed {
		t.Fatalf("Follow = %v, %v; want nothing done", followed, err)
	}
	if after, _ := os.ReadFile(a.PlistPath()); !bytes.Equal(before, after) {
		t.Error("another household's plist was rewritten")
	}
	if len(*calls) != 0 {
		t.Errorf("launchctl was called: %v", *calls)
	}
}

func TestFollowWithNoScheduleInstalledDoesNothing(t *testing.T) {
	a, calls := followerFor(t)
	followed, err := a.Follow(oldFolder)
	if err != nil || followed {
		t.Fatalf("Follow = %v, %v; want nothing done", followed, err)
	}
	if a.Installed() || len(*calls) != 0 {
		t.Errorf("a schedule appeared (installed %v, launchctl %v)", a.Installed(), *calls)
	}
}

// A schedule installed before retention was configurable keeps the default; following a
// move must not write a --keep it never had.
func TestFollowKeepsAScheduleWithNoRetentionWithout(t *testing.T) {
	a, _ := followerFor(t)
	installedAs(t, a, oldFolder, "03:00", 0)
	if _, err := a.Follow(oldFolder); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(a.PlistPath())
	args, _ := programArguments(raw)
	if contains(args, "--keep") {
		t.Errorf("program arguments %v gained a --keep", args)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
