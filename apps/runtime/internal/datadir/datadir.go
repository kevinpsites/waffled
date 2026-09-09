// Package datadir owns the directory Waffled keeps its state in — the layout from
// docs/product/native-mac-plan.md §3, plus the two macOS traps that live with it: the
// 104-byte unix socket path limit and the "never put a live PGDATA in iCloud" rule.
//
// Nothing here writes into the bundle. An app bundle is read-only once signed, so
// PGDATA, media, logs, pidfiles, PowerSync's .probes/, Caddy's state and the generated
// Caddyfile all live under this root.
package datadir

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AppName is the folder Waffled uses inside the platform's application-support location.
const AppName = "Waffled"

// macOS's sockaddr_un.sun_path is 104 bytes including the terminating NUL, and Postgres
// appends "/.s.PGSQL.<port>" (up to 16 characters) to the socket directory. Staying
// under this leaves room for that plus a margin. Exceed it and the postmaster starts,
// logs nothing alarming, and is simply unreachable over the socket.
const maxSocketDirLen = 85

// SocketDirPrefix names the fallback socket directory made when the data path is too
// long. `uninstall` matches on it: that directory is the one thing outside the data root
// this runtime deletes, and the path comes out of runtime.json, so the prefix is what
// keeps a hand-edited file from turning an uninstall into an rm -rf of somewhere else.
const SocketDirPrefix = "wfl"

// Layout is every path the runtime uses, derived from one root.
type Layout struct {
	Root        string
	ConfigEnv   string
	Postgres    string // PGDATA
	Media       string // uploaded blobs; the api writes, Caddy serves
	Backups     string // pg_dump output: routine backups and pre-migration snapshots
	Logs        string // one file per service
	Pids        string
	RuntimeJSON string
	// PowerSync is the service's working directory. It writes .probes/ into its cwd,
	// which must therefore not be the read-only bundle.
	PowerSync string
	// Caddy holds XDG_DATA_HOME/XDG_CONFIG_HOME state and the generated Caddyfile.
	Caddy         string
	CaddyfilePath string
	// BundleCache memoizes a successful manifest verification (see internal/manifest).
	BundleCache string
	// BonjourState records what the running supervisor is advertising, so `status` —
	// which runs in a different process — can report it without asking the database.
	BonjourState string
}

// At derives the layout from a root directory.
func At(root string) Layout {
	return Layout{
		Root:          root,
		ConfigEnv:     filepath.Join(root, "config.env"),
		Postgres:      filepath.Join(root, "postgres"),
		Media:         filepath.Join(root, "media"),
		Backups:       filepath.Join(root, "backups"),
		Logs:          filepath.Join(root, "logs"),
		Pids:          filepath.Join(root, "pids"),
		RuntimeJSON:   filepath.Join(root, "runtime.json"),
		PowerSync:     filepath.Join(root, "powersync"),
		Caddy:         filepath.Join(root, "caddy"),
		CaddyfilePath: filepath.Join(root, "Caddyfile"),
		BundleCache:   filepath.Join(root, "bundle-verified.json"),
		BonjourState:  filepath.Join(root, "bonjour.json"),
	}
}

// Default is the layout at DefaultRoot.
func Default() (Layout, error) {
	root, err := DefaultRoot()
	if err != nil {
		return Layout{}, err
	}
	return At(root), nil
}

// Ensure creates every directory, owner-only. Safe on every start.
func (l Layout) Ensure() error {
	for _, dir := range []string{l.Root, l.Postgres, l.Media, l.Backups, l.Logs, l.Pids, l.PowerSync, l.Caddy} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	// MkdirAll respects umask, and an existing directory keeps whatever mode it had.
	if err := os.Chmod(l.Root, 0o700); err != nil {
		return fmt.Errorf("secure %s: %w", l.Root, err)
	}
	return nil
}

// LogPath and PidPath name a service's files.
func (l Layout) LogPath(service string) string { return filepath.Join(l.Logs, service+".log") }
func (l Layout) PidPath(service string) string { return filepath.Join(l.Pids, service+".pid") }

// SocketDir returns the directory Postgres should put its unix socket in, and whether
// that is a fallback rather than PGDATA itself. `recorded` is the value runtime.json
// remembers from a previous run: reusing it keeps the socket path stable across restarts.
func (l Layout) SocketDir(recorded string) (dir string, fellBack bool, err error) {
	if recorded != "" {
		if err := os.MkdirAll(recorded, 0o700); err != nil {
			return "", false, fmt.Errorf("create the postgres socket directory %s: %w", recorded, err)
		}
		return recorded, recorded != l.Postgres, nil
	}
	if len(l.Postgres) <= maxSocketDirLen {
		return l.Postgres, false, nil
	}
	tmp, err := os.MkdirTemp("", SocketDirPrefix)
	if err != nil {
		return "", false, fmt.Errorf("create a short postgres socket directory: %w", err)
	}
	if len(tmp) > maxSocketDirLen {
		os.RemoveAll(tmp)
		return "", false, fmt.Errorf("even %s is too long for a unix socket path", tmp)
	}
	return tmp, true, nil
}

// syncedLocations are directories macOS or a third party continuously syncs. A live
// Postgres cluster inside one is a corruption waiting to happen.
var syncedLocations = []struct{ rel, why string }{
	{"Desktop", "iCloud Drive syncs Desktop"},
	{"Documents", "iCloud Drive syncs Documents"},
	{filepath.Join("Library", "Mobile Documents"), "this is iCloud Drive"},
	{"Dropbox", "Dropbox syncs this folder"},
	{filepath.Join("Library", "CloudStorage"), "this is a cloud-synced folder"},
	{"Google Drive", "Google Drive syncs this folder"},
	{"OneDrive", "OneDrive syncs this folder"},
}

// Risks reports human-readable warnings about where the data directory sits. It is
// advice for `doctor`, never a reason to refuse to start — the operator chose the path.
func (l Layout) Risks() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	abs, err := filepath.Abs(l.Root)
	if err != nil {
		abs = l.Root
	}
	var warnings []string
	for _, loc := range syncedLocations {
		prefix := filepath.Join(home, loc.rel)
		if abs == prefix || strings.HasPrefix(abs, prefix+string(filepath.Separator)) {
			warnings = append(warnings, fmt.Sprintf(
				"the data directory is inside %s — %s, and a synced Postgres cluster will be corrupted. "+
					"Move it to ~/Library/Application Support/%s.", prefix, loc.why, AppName))
		}
	}
	return warnings
}
