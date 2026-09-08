package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The memo must not wave through a bundled file that changed after it was written.
// Keying only on manifest.json meant `echo x >> bin/node` passed every warm start: the
// manifest was untouched, so the cache hit and the altered binary was handed back as
// verified. The key now carries the size and mtime of every listed path, so a tampered
// file misses the cache and the full verify refuses it.
func TestVerifyCachedRefusesAFileTamperedWithAfterACachedVerify(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")
	if _, _, err := VerifyCached(root, cache); err != nil {
		t.Fatal(err)
	}
	if _, cached, err := VerifyCached(root, cache); err != nil || !cached {
		t.Fatalf("an untouched bundle should be a cache hit (cached=%v, err=%v)", cached, err)
	}

	// Tamper with a bundled binary, leaving manifest.json exactly as it was.
	victim := filepath.Join(root, "bin", "node")
	f, err := os.OpenFile(victim, os.O_WRONLY|os.O_APPEND, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("echo pwned\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()

	m, cached, err := VerifyCached(root, cache)
	if cached {
		t.Error("a mutated bundled file must miss the cache")
	}
	if err == nil {
		t.Fatalf("a tampered bundle must be refused, got manifest %+v", m)
	}
	if !strings.Contains(err.Error(), "changed: bin/node") {
		t.Errorf("the refusal should name the altered file, got: %v", err)
	}
}

// A retargeted symlink is the same class of bypass — bin/postgres/lib is 17 relative
// links deep — so the digest lstats symlinks too.
func TestVerifyCachedRefusesARetargetedSymlink(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")
	if _, _, err := VerifyCached(root, cache); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(root, "bin", "postgres", "lib", "libpq.dylib")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", link); err != nil {
		t.Fatal(err)
	}

	_, cached, err := VerifyCached(root, cache)
	if cached {
		t.Error("a retargeted symlink must miss the cache")
	}
	if err == nil {
		t.Fatal("a retargeted symlink must be refused")
	}
}

// A file rewritten with identical content still misses the cache — mtime moved — and
// then passes the full verify. That is the intended trade: the memo is conservative,
// so a miss costs a walk rather than trusting a file it has not looked at.
func TestVerifyCachedReVerifiesWhenAFileIsRewrittenIdentically(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")
	if _, _, err := VerifyCached(root, cache); err != nil {
		t.Fatal(err)
	}

	same := filepath.Join(root, "config", "Caddyfile")
	body, err := os.ReadFile(same)
	if err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(same, later, later); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(same); string(got) != string(body) {
		t.Fatal("the fixture file should be unchanged")
	}

	m, cached, err := VerifyCached(root, cache)
	if err != nil {
		t.Fatalf("identical content must still verify: %v", err)
	}
	if cached {
		t.Error("a file whose mtime moved must miss the cache and be re-walked")
	}
	if m == nil {
		t.Fatal("expected a manifest")
	}
}

// A cache file written by an older build carries no file digest. It must be treated as
// a miss — never trusted, never a crash.
func TestVerifyCachedTreatsALegacyCacheEntryAsAMiss(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")
	if _, _, err := VerifyCached(root, cache); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cache)
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatal(err)
	}
	delete(entry, "filesDigest")
	rewritten, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cache, rewritten, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, cached, err := VerifyCached(root, cache); err != nil || cached {
		t.Errorf("a cache entry with no file digest must be re-verified (cached=%v, err=%v)", cached, err)
	}
}
