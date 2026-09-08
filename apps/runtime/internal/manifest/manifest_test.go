package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fixture builds a miniature runtime tree — a couple of files, an exec bit, and a
// relative symlink like the ones Postgres' lib/ and PowerSync's node_modules depend on —
// then writes a manifest for it.
func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "bin", "node"), "#!/bin/sh\necho node\n", 0o755)
	mustWrite(t, filepath.Join(root, "api", "dist", "server.js"), "console.log('api')\n", 0o644)
	mustWrite(t, filepath.Join(root, "config", "Caddyfile"), ":80 {\n}\n", 0o644)
	mustWrite(t, filepath.Join(root, "bin", "postgres", "lib", "libpq.5.dylib"), "not really a dylib\n", 0o644)
	if err := os.Symlink("libpq.5.dylib", filepath.Join(root, "bin", "postgres", "lib", "libpq.dylib")); err != nil {
		t.Fatal(err)
	}

	files, symlinks, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	m := &Manifest{
		Schema: Schema, Name: "waffled-runtime",
		Arch: runtime.GOARCH, Platform: runtime.GOOS,
		BuiltAt: "2026-09-04T23:48:42.438Z", GitSha: "a506c352", WaffledVersion: "0.14.3",
		Files: files, Symlinks: symlinks,
	}
	m.FileCount = len(files)
	m.SymlinkCount = len(symlinks)
	raw, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, FileName), append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func mustWrite(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyAcceptsAnIntactTree(t *testing.T) {
	root := fixture(t)
	m, err := Verify(root)
	if err != nil {
		t.Fatalf("an untouched tree must verify: %v", err)
	}
	if m.WaffledVersion != "0.14.3" {
		t.Errorf("version not surfaced: %+v", m)
	}
}

// manifest.json itself is never listed in files{} — verifying must not trip over it.
func TestManifestFileIsNotPartOfTheTree(t *testing.T) {
	root := fixture(t)
	files, _, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, listed := files[FileName]; listed {
		t.Error("Scan must exclude manifest.json, as manifest.mjs does")
	}
}

func TestVerifyRefusesATamperedFile(t *testing.T) {
	root := fixture(t)
	// A single appended byte — the negative test build.sh's README documents.
	f, err := os.OpenFile(filepath.Join(root, "config", "Caddyfile"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("x")
	f.Close()

	_, err = Verify(root)
	if err == nil {
		t.Fatal("a modified file must be refused")
	}
	if !strings.Contains(err.Error(), "config/Caddyfile") {
		t.Errorf("the error should name the file, got %q", err)
	}
}

func TestVerifyRefusesAnExtraFile(t *testing.T) {
	root := fixture(t)
	mustWrite(t, filepath.Join(root, "api", "extra.txt"), "hello\n", 0o644)
	_, err := Verify(root)
	if err == nil {
		t.Fatal("an extra file must be refused")
	}
	if !strings.Contains(err.Error(), "extra.txt") {
		t.Errorf("the error should name the extra file, got %q", err)
	}
}

func TestVerifyRefusesAMissingFile(t *testing.T) {
	root := fixture(t)
	if err := os.Remove(filepath.Join(root, "bin", "postgres", "lib", "libpq.5.dylib")); err != nil {
		t.Fatal(err)
	}
	_, err := Verify(root)
	if err == nil {
		t.Fatal("a missing file must be refused")
	}
	if !strings.Contains(err.Error(), "libpq.5.dylib") {
		t.Errorf("the error should name the missing file, got %q", err)
	}
}

// Postgres dies at dyld time without its 17 lib symlinks and PowerSync resolves no
// import without pnpm's 1,321 — a missing link is as fatal as a missing file.
func TestVerifyRefusesAMissingSymlink(t *testing.T) {
	root := fixture(t)
	if err := os.Remove(filepath.Join(root, "bin", "postgres", "lib", "libpq.dylib")); err != nil {
		t.Fatal(err)
	}
	_, err := Verify(root)
	if err == nil {
		t.Fatal("a removed symlink must be refused")
	}
	if !strings.Contains(err.Error(), "libpq.dylib") {
		t.Errorf("the error should name the symlink, got %q", err)
	}
}

func TestVerifyRefusesARetargetedSymlink(t *testing.T) {
	root := fixture(t)
	link := filepath.Join(root, "bin", "postgres", "lib", "libpq.dylib")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", link); err != nil {
		t.Fatal(err)
	}
	_, err := Verify(root)
	if err == nil {
		t.Fatal("a retargeted symlink must be refused")
	}
}

// A symlink must never be followed: doing so would hash the target's bytes and turn a
// pnpm link farm into thousands of phantom "extra files".
func TestScanRecordsSymlinksWithoutFollowingThem(t *testing.T) {
	root := fixture(t)
	files, symlinks, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if target := symlinks["bin/postgres/lib/libpq.dylib"]; target != "libpq.5.dylib" {
		t.Errorf("symlink target = %q, want %q", target, "libpq.5.dylib")
	}
	if _, wrongly := files["bin/postgres/lib/libpq.dylib"]; wrongly {
		t.Error("a symlink was recorded as a regular file — it was followed")
	}
}

func TestVerifyRefusesTheWrongArchitecture(t *testing.T) {
	root := fixture(t)
	m, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	m.Arch = "some-other-arch"
	writeManifest(t, root, m)

	_, err = Verify(root)
	if err == nil {
		t.Fatal("a bundle built for another architecture must be refused")
	}
	if !strings.Contains(err.Error(), "some-other-arch") {
		t.Errorf("the error should name the mismatch, got %q", err)
	}
}

func TestVerifyRefusesAFutureSchema(t *testing.T) {
	root := fixture(t)
	m, _ := Load(root)
	m.Schema = 99
	writeManifest(t, root, m)
	if _, err := Verify(root); err == nil {
		t.Fatal("a manifest schema this binary does not understand must be refused")
	}
}

// The exec bit is the one permission bit that is load-bearing; a copy that lost it
// leaves a bundle whose binaries cannot run.
func TestVerifyRefusesALostExecBit(t *testing.T) {
	root := fixture(t)
	if err := os.Chmod(filepath.Join(root, "bin", "node"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Verify(root)
	if err == nil {
		t.Fatal("a binary that lost its exec bit must be refused")
	}
	if !strings.Contains(err.Error(), "bin/node") {
		t.Errorf("the error should name the file, got %q", err)
	}
}

// Hashing 36k files / 580 MB takes seconds; a warm start must not pay it again.
func TestVerifyCachedSkipsTheSecondWalk(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")

	m, cached, err := VerifyCached(root, cache)
	if err != nil {
		t.Fatal(err)
	}
	if cached {
		t.Error("the first call cannot be a cache hit")
	}
	if m == nil {
		t.Fatal("expected a manifest")
	}

	_, cached, err = VerifyCached(root, cache)
	if err != nil {
		t.Fatal(err)
	}
	if !cached {
		t.Error("the second call against an unchanged bundle should hit the cache")
	}
}

// A swapped build at the same path must invalidate the memo: the key includes the hash
// of manifest.json, which changes with the git sha. That is only half the guarantee —
// a file altered without touching the manifest is covered by the stat fingerprint, in
// manifest_cache_test.go.
func TestVerifyCachedIsInvalidatedByADifferentBundle(t *testing.T) {
	root := fixture(t)
	cache := filepath.Join(t.TempDir(), "bundle-verified.json")
	if _, _, err := VerifyCached(root, cache); err != nil {
		t.Fatal(err)
	}
	m, _ := Load(root)
	m.GitSha = "0000000"
	writeManifest(t, root, m)

	_, cached, err := VerifyCached(root, cache)
	if err != nil {
		t.Fatal(err)
	}
	if cached {
		t.Error("a changed manifest.json must invalidate the cache")
	}
}

func TestComponentVersionsAreReadable(t *testing.T) {
	root := fixture(t)
	m, _ := Load(root)
	m.Components = Components{
		Node:      Component{Version: "24.19.0", Path: "bin/node"},
		Postgres:  Component{Version: "16.14", Path: "bin/postgres"},
		Caddy:     Component{Version: "2.11.4", Path: "bin/caddy"},
		API:       Component{Version: "0.14.3", Path: "api", Serve: "api/dist/server.js", Migrate: "api/dist/migrate.js"},
		PowerSync: Component{Version: "1.22.0", Path: "powersync", Entry: "powersync/service/lib/entry.js"},
		Web:       Component{Version: "0.14.3", Path: "web"},
	}
	writeManifest(t, root, m)

	got, err := Verify(root)
	if err != nil {
		t.Fatal(err)
	}
	if got.Components.API.Serve != "api/dist/server.js" {
		t.Errorf("api serve entry lost: %+v", got.Components.API)
	}
	if got.Components.PowerSync.Entry != "powersync/service/lib/entry.js" {
		t.Errorf("powersync entry lost: %+v", got.Components.PowerSync)
	}
	versions := got.VersionSummary()
	if !strings.Contains(versions, "24.19.0") || !strings.Contains(versions, "1.22.0") {
		t.Errorf("VersionSummary should mention component versions, got %q", versions)
	}
}

func TestVerifyReportsAtMostAHandfulOfProblems(t *testing.T) {
	root := fixture(t)
	for i := range 40 {
		mustWrite(t, filepath.Join(root, "junk", string(rune('a'+i%26))+string(rune('a'+i/26))), "x", 0o644)
	}
	_, err := Verify(root)
	if err == nil {
		t.Fatal("expected refusal")
	}
	if n := strings.Count(err.Error(), "\n"); n > 30 {
		t.Errorf("the error should be truncated for humans, got %d lines", n+1)
	}
	if !strings.Contains(err.Error(), "more") {
		t.Errorf("a truncated list should say how many more, got %q", err)
	}
}

func writeManifest(t *testing.T, root string, m *Manifest) {
	t.Helper()
	raw, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, FileName), append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
