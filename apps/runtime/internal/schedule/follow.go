package schedule

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Follow points the installed nightly backup at the folder a data directory was moved
// to. a is the agent for the new folder; from is the folder it moved from.
//
// Only when the installed plist backs up from: the label is global, and another
// household's schedule is not this move's to rewrite. The time, the retention, and the
// binary and bundle the schedule was installed with are kept — whichever binary ran the
// move is not a reason to change what runs at night. Reports whether it re-installed.
func (a *Agent) Follow(from string) (bool, error) {
	dir, err := a.ScheduledDataDir()
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if filepath.Clean(dir) != filepath.Clean(from) {
		return false, nil
	}
	raw, err := os.ReadFile(a.PlistPath())
	if err != nil {
		return false, err
	}
	args, err := programArguments(raw)
	if err != nil {
		return false, err
	}
	a.BinaryPath, a.BundleDir = args[0], ""
	if bundle, found, err := a.scheduledFlag("--bundle"); err == nil && found {
		a.BundleDir = bundle
	}
	if a.At, err = a.ScheduledAt(); err != nil {
		return false, err
	}
	if a.Keep, err = a.ScheduledKeep(); err != nil {
		return false, err
	}
	if err := a.Install(); err != nil {
		return false, err
	}
	return true, nil
}
