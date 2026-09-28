package datadir

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLayoutMatchesThePlan(t *testing.T) {
	root := "/Users/kev/Library/Application Support/Waffled"
	l := At(root)
	cases := map[string]string{
		"config.env":   l.ConfigEnv,
		"postgres":     l.Postgres,
		"media":        l.Media,
		"backups":      l.Backups,
		"logs":         l.Logs,
		"pids":         l.Pids,
		"runtime.json": l.RuntimeJSON,
	}
	for name, got := range cases {
		want := filepath.Join(root, name)
		if got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	// PowerSync needs a writable cwd of its own — it creates .probes/ there, and the
	// bundle is read-only after signing.
	if !strings.HasPrefix(l.PowerSync, root) {
		t.Errorf("powersync working dir %q must live under the data dir", l.PowerSync)
	}
}

func TestEnsureCreatesEveryDirectory(t *testing.T) {
	l := At(filepath.Join(t.TempDir(), "Application Support", "Waffled"))
	if err := l.Ensure(); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{l.Root, l.Postgres, l.Media, l.Backups, l.Logs, l.Pids, l.PowerSync, l.Caddy} {
		st, err := os.Stat(dir)
		if err != nil {
			t.Errorf("%s was not created: %v", dir, err)
			continue
		}
		if !st.IsDir() {
			t.Errorf("%s is not a directory", dir)
		}
	}
	// Ensure must be safe to call on every start.
	if err := l.Ensure(); err != nil {
		t.Fatalf("Ensure is not idempotent: %v", err)
	}
}

// The whole data directory holds secrets and family data; it should not be world-readable.
func TestEnsureCreatesAnOwnerOnlyRoot(t *testing.T) {
	l := At(filepath.Join(t.TempDir(), "Waffled"))
	if err := l.Ensure(); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(l.Root)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("data dir should not be group/world accessible, got %o", perm)
	}
}

func TestDefaultRootIsApplicationSupportOnMacOS(t *testing.T) {
	root, err := DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if !strings.HasSuffix(root, filepath.Join("Library", "Application Support", "Waffled")) {
			t.Errorf("default root = %q, want ~/Library/Application Support/Waffled", root)
		}
	}
	if root == "" {
		t.Error("a default root must be defined for every platform")
	}
}

// macOS caps a unix socket path at 104 bytes including the NUL. Postgres appends
// /.s.PGSQL.<port>, so a deep PGDATA (a t.TempDir() under /var/folders, say) silently
// makes the cluster unreachable. The runtime must notice and use a short directory.
func TestSocketDirFallsBackWhenPGDATAIsTooLong(t *testing.T) {
	short := At("/Users/kev/Library/Application Support/Waffled")
	dir, fellBack, err := short.SocketDir("")
	if err != nil {
		t.Fatal(err)
	}
	if fellBack {
		t.Errorf("a normal data dir should use PGDATA itself, got %q", dir)
	}
	if dir != short.Postgres {
		t.Errorf("socket dir = %q, want %q", dir, short.Postgres)
	}

	deep := At("/" + strings.Repeat("verylongsegment/", 8) + "Application Support/Waffled")
	dir, fellBack, err = deep.SocketDir("")
	if err != nil {
		t.Fatal(err)
	}
	if !fellBack {
		t.Fatalf("a %d-char PGDATA must not be used as the socket directory", len(deep.Postgres))
	}
	if len(dir) > maxSocketDirLen {
		t.Errorf("the fallback socket dir is itself too long: %d chars (%q)", len(dir), dir)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
}

// A socket directory recorded in runtime.json must be reused, so a restart does not
// strand clients (and old sockets) in a different temp directory each time.
func TestSocketDirReusesARecordedDirectory(t *testing.T) {
	deep := At("/" + strings.Repeat("verylongsegment/", 8) + "Waffled")
	first, _, err := deep.SocketDir("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(first) })

	again, fellBack, err := deep.SocketDir(first)
	if err != nil {
		t.Fatal(err)
	}
	if !fellBack || again != first {
		t.Errorf("recorded socket dir %q was not reused, got %q", first, again)
	}
}

func TestLogPathAndPidPathAreUnderTheirDirectories(t *testing.T) {
	l := At("/data")
	if got := l.LogPath("api"); got != "/data/logs/api.log" {
		t.Errorf("LogPath = %q", got)
	}
	if got := l.PidPath("caddy"); got != "/data/pids/caddy.pid" {
		t.Errorf("PidPath = %q", got)
	}
}

// iCloud syncs Desktop/Documents; a live PGDATA there gets corrupted. doctor warns.
func TestRisksFlagsSyncedLocations(t *testing.T) {
	home, _ := os.UserHomeDir()
	for _, bad := range []string{
		filepath.Join(home, "Desktop", "Waffled"),
		filepath.Join(home, "Documents", "Waffled"),
		filepath.Join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Waffled"),
		filepath.Join(home, "Dropbox", "Waffled"),
	} {
		if warnings := At(bad).Risks(); len(warnings) == 0 {
			t.Errorf("%q should be flagged as a synced location", bad)
		}
	}
	safe := At(filepath.Join(home, "Library", "Application Support", "Waffled"))
	if warnings := safe.Risks(); len(warnings) != 0 {
		t.Errorf("the default location should be clean, got %v", warnings)
	}
}
