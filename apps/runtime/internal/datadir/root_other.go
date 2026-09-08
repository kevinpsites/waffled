//go:build !darwin

package datadir

import (
	"fmt"
	"os"
	"path/filepath"
)

// DefaultRoot on non-macOS platforms. The supervisor is deliberately kept free of
// macOS-only APIs so it can cross-compile to Windows later (plan §9); these are the
// conventional locations, and nothing has been tested against them yet.
//
// TODO(windows): %LOCALAPPDATA%\Waffled once Phase "Later" reaches Windows.
// TODO(linux): honour XDG_DATA_HOME rather than assuming ~/.local/share.
func DefaultRoot() (string, error) {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, AppName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate the home directory: %w", err)
	}
	return filepath.Join(home, "."+AppName), nil
}

// ExcludeFromBackup is a no-op away from macOS: Time Machine is the specific hazard
// this guards against.
func ExcludeFromBackup(string) error { return nil }

// IsExcludedFromBackup reports false where the concept does not apply.
func IsExcludedFromBackup(string) bool { return false }
