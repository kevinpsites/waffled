//go:build integration

// Real-bundle checks for the verification memo. Kept behind the integration tag: they
// need the shipped bundle, and they report timings, which has no business in the unit
// suite. Nothing here asserts a duration — the numbers are logged so the cost of the
// stat fingerprint can be re-measured on real hardware rather than argued about.
package manifest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTheRealBundleVerifiesAndThenHitsTheMemo(t *testing.T) {
	root := os.Getenv("WAFFLED_BUNDLE")
	if root == "" {
		t.Skip("set WAFFLED_BUNDLE to the runtime bundle")
	}
	m, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		start := time.Now()
		if treeDigest(root, m) == "" {
			t.Fatal("the fingerprint must not be empty")
		}
		t.Logf("fingerprint run %d: %d files + %d symlinks in %s",
			i, len(m.Files), len(m.Symlinks), time.Since(start))
	}

	cachePath := filepath.Join(t.TempDir(), "bundle-verified.json")
	start := time.Now()
	if _, cached, err := VerifyCached(root, cachePath); err != nil || cached {
		t.Fatalf("the first call must be a full walk that succeeds (cached=%v, err=%v)", cached, err)
	}
	t.Logf("cold VerifyCached (full walk): %s", time.Since(start))

	start = time.Now()
	if _, cached, err := VerifyCached(root, cachePath); err != nil || !cached {
		t.Fatalf("the second call must hit the memo (cached=%v, err=%v)", cached, err)
	}
	t.Logf("warm VerifyCached (memo hit): %s", time.Since(start))
}
