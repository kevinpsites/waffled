package supervisor

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
)

// BackupAgent builds the launchd agent for this install: the binary currently running,
// pointed at this bundle and this data directory.
//
// The paths are resolved here rather than inside the agent because a launchd job gets a
// minimal environment and no useful working directory — everything it needs has to be
// baked into the plist at install time, including which data directory to back up.
func (s *Supervisor) BackupAgent() (*schedule.Agent, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate this binary: %w", err)
	}
	// A symlinked binary would put the link, not the target, in the plist — and the link
	// may not survive an update. resolveBundle resolves the same way for the same reason.
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return schedule.For(exe, s.plan.Bundle, s.plan.Layout.Root, s.plan.Layout.LogPath("backup"))
}

// scheduleInstalled answers the status block's question without running launchctl, which
// `status` polls too often to afford. It tolerates a failure to even look: a missing home
// directory is not a reason for `status` to produce nothing.
func (s *Supervisor) scheduleInstalled() bool {
	a, err := s.BackupAgent()
	if err != nil {
		return false
	}
	return a.Installed()
}

// scheduleLoaded asks launchd whether the installed job is really loaded — the question
// scheduleInstalled cannot answer, because a plist on disk and a job launchd holds are
// different facts and a failed bootstrap leaves only the first.
//
// Only `doctor` calls it: it forks launchctl, and it is skipped away from macOS, where
// there is no launchd to ask.
func (s *Supervisor) scheduleLoaded() (bool, error) {
	if runtime.GOOS != "darwin" {
		return true, nil
	}
	a, err := s.BackupAgent()
	if err != nil {
		return false, err
	}
	return a.Loaded()
}
