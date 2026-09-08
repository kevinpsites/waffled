//go:build darwin

package datadir

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// DefaultRoot is ~/Library/Application Support/Waffled — the plan's §3 location, and the
// reason so much of this package cares about spaces in paths.
func DefaultRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate the home directory: %w", err)
	}
	return filepath.Join(home, "Library", "Application Support", AppName), nil
}

// ExcludeFromBackup marks a path so Time Machine skips it. Restoring a live Postgres
// cluster from a file-level backup produces a corrupt cluster (plan §5), so PGDATA is
// excluded and `backups/` — which is a consistent pg_dump — is what gets backed up.
//
// tmutil sets the com.apple.metadata:com_apple_backup_excludeItem xattr itself and is
// the documented interface; the sticky (non -p) form needs no admin rights on a path
// the user owns. Being unable to exclude is worth a warning, never a failed start.
func ExcludeFromBackup(path string) error {
	if out, err := exec.Command("/usr/bin/tmutil", "addexclusion", path).CombinedOutput(); err != nil {
		return fmt.Errorf("tmutil addexclusion %s: %w (%s)", path, err, strings.TrimSpace(string(out)))
	}
	if !IsExcludedFromBackup(path) {
		return fmt.Errorf("tmutil reported success but %s is still included in Time Machine backups", path)
	}
	return nil
}

// IsExcludedFromBackup asks tmutil, which is the authority — rather than reading the
// xattr back and hoping the encoding was right.
func IsExcludedFromBackup(path string) bool {
	out, err := exec.Command("/usr/bin/tmutil", "isexcluded", path).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "[Excluded]")
}
