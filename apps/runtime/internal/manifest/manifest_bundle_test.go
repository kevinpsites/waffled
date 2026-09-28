//go:build integration

package manifest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The synthetic fixtures prove the rules; this proves the port against the real thing —
// 36k files, 1.3k pnpm/dylib symlinks, 580 MB — and reports what a cold verify costs,
// which is the number that decides whether the result has to be cached.
func TestVerifyTheRealBundle(t *testing.T) {
	root := os.Getenv("WAFFLED_BUNDLE")
	if root == "" {
		t.Skip("set WAFFLED_BUNDLE to the runtime bundle directory to run this")
	}

	t0 := time.Now()
	m, err := Verify(root)
	cold := time.Since(t0)
	if err != nil {
		t.Fatalf("the real bundle failed to verify: %v", err)
	}
	t.Logf("cold verify: %s — %d files + %d symlinks, %.0f MB, %s/%s",
		cold.Round(time.Millisecond), m.FileCount, m.SymlinkCount,
		float64(m.TotalBytes)/1e6, m.Arch, m.Platform)
	t.Logf("versions: %s", m.VersionSummary())

	if m.FileCount < 10000 || m.SymlinkCount < 100 {
		t.Errorf("this does not look like the real bundle: %d files, %d symlinks", m.FileCount, m.SymlinkCount)
	}
	// The entry points the supervisor spawns must be named by the manifest, not guessed.
	for what, rel := range map[string]string{
		"node":            m.Components.Node.Path,
		"api server":      m.Components.API.Serve,
		"api migrate":     m.Components.API.Migrate,
		"powersync entry": m.Components.PowerSync.Entry,
	} {
		if rel == "" {
			t.Errorf("manifest does not name the %s entry point", what)
			continue
		}
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Errorf("%s (%s) is not in the bundle: %v", what, rel, err)
		}
	}

	cachePath := filepath.Join(t.TempDir(), "bundle-verified.json")
	t1 := time.Now()
	if _, cached, err := VerifyCached(root, cachePath); err != nil || cached {
		t.Fatalf("first VerifyCached: cached=%v err=%v", cached, err)
	}
	t.Logf("VerifyCached (cold): %s", time.Since(t1).Round(time.Millisecond))

	t2 := time.Now()
	if _, cached, err := VerifyCached(root, cachePath); err != nil || !cached {
		t.Fatalf("second VerifyCached should hit the cache: cached=%v err=%v", cached, err)
	}
	warm := time.Since(t2)
	t.Logf("VerifyCached (warm): %s", warm.Round(time.Millisecond))
	if warm > cold/4 {
		t.Errorf("the cache saved nothing: warm %s vs cold %s", warm, cold)
	}
}
