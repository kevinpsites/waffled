// Package manifest is the Go port of infra/native/bundle/manifest.mjs (branch
// native-bundle) — the check that proves the runtime bundle is exactly what was built
// and signed before anything in it is executed.
//
// The rules, from the bundle README's "Contract for waffled-runtime" §1:
//
//	set equality on files and on symlinks, sha256 per file, the owner-exec bit,
//	arch == runtime.GOARCH and platform == runtime.GOOS.
//
// Symlinks are recorded as link targets and never followed. That is not a nicety:
// bin/postgres/lib carries 17 relative links without which `postgres` dies at dyld
// time, and PowerSync's node_modules is a 1,321-link pnpm farm. Following them would
// both mis-hash and produce thousands of phantom entries.
//
// One rule is not set equality and could not be: every symlink must also resolve INSIDE
// the bundle (escapesRoot). A link that escaped when the bundle was built is recorded
// faithfully, so the manifest agrees with the disk and nothing else notices — but the
// bundle is relocatable only because all of its links are relative and land inside it.
package manifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

// Schema is the manifest layout this binary understands.
const Schema = 1

// FileName is the manifest's name inside the bundle root. It is never itself listed.
const FileName = "manifest.json"

// maxReportedProblems keeps a failure message readable; manifest.mjs uses the same idea.
const maxReportedProblems = 25

// FileEntry is one regular file: its content hash, size, and octal permission bits.
type FileEntry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   string `json:"mode"`
}

// Component describes one shipped piece. Fields absent for a given component stay empty.
type Component struct {
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
	Source  string `json:"source,omitempty"`
	// api
	Serve      string `json:"serve,omitempty"`
	Migrate    string `json:"migrate,omitempty"`
	Migrations string `json:"migrations,omitempty"`
	// powersync
	Entry string `json:"entry,omitempty"`
}

// Components is the typed subset of the manifest's components object that the runtime
// actually drives. Unknown members are ignored rather than rejected, so a bundle can
// grow a component without this binary refusing to start.
type Components struct {
	Node      Component `json:"node"`
	Postgres  Component `json:"postgres"`
	Caddy     Component `json:"caddy"`
	API       Component `json:"api"`
	PowerSync Component `json:"powersync"`
	Web       Component `json:"web"`
	Config    Component `json:"config"`
}

// Manifest is manifest.json, schema 1.
type Manifest struct {
	Schema         int                  `json:"schema"`
	Name           string               `json:"name"`
	Arch           string               `json:"arch"`
	Platform       string               `json:"platform"`
	BuiltAt        string               `json:"builtAt"`
	GitSha         string               `json:"gitSha"`
	GitDirty       bool                 `json:"gitDirty"`
	WaffledVersion string               `json:"waffledVersion"`
	Components     Components           `json:"components"`
	FileCount      int                  `json:"fileCount"`
	SymlinkCount   int                  `json:"symlinkCount"`
	TotalBytes     int64                `json:"totalBytes"`
	Files          map[string]FileEntry `json:"files"`
	Symlinks       map[string]string    `json:"symlinks"`
}

// VersionSummary is the one-line provenance string status and doctor print.
func (m *Manifest) VersionSummary() string {
	c := m.Components
	return fmt.Sprintf("waffled %s · node %s · postgres %s · caddy %s · powersync %s · api %s · web %s",
		m.WaffledVersion, c.Node.Version, c.Postgres.Version, c.Caddy.Version,
		c.PowerSync.Version, c.API.Version, c.Web.Version)
}

// Load reads and sanity-checks manifest.json without walking the tree.
func Load(root string) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(root, FileName))
	if err != nil {
		return nil, fmt.Errorf("read the bundle manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", filepath.Join(root, FileName), err)
	}
	return &m, nil
}

// Scan walks the bundle, hashing every regular file and recording every symlink. Paths
// are POSIX-relative to root; manifest.json is excluded.
func Scan(root string) (map[string]FileEntry, map[string]string, error) {
	files := map[string]FileEntry{}
	symlinks := map[string]string{}
	var pending []string

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == FileName {
			return nil
		}
		// Branch on symlink BEFORE recursing, so a link to a directory is recorded as a
		// link and never descended into.
		if d.Type()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			symlinks[rel] = target
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("unsupported entry (not a file/dir/symlink): %s", rel)
		}
		pending = append(pending, rel)
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("walk the bundle: %w", err)
	}

	// Hash with bounded concurrency — 36k files is I/O bound, not CPU bound.
	var (
		mu       sync.Mutex
		firstErr error
		wg       sync.WaitGroup
		next     = make(chan string, 64)
	)
	workers := runtime.NumCPU() * 4
	if workers > 32 {
		workers = 32
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rel := range next {
				entry, err := hashFile(filepath.Join(root, filepath.FromSlash(rel)))
				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
				} else {
					files[rel] = entry
				}
				mu.Unlock()
			}
		}()
	}
	for _, rel := range pending {
		next <- rel
	}
	close(next)
	wg.Wait()
	if firstErr != nil {
		return nil, nil, firstErr
	}
	return files, symlinks, nil
}

func hashFile(path string) (FileEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileEntry{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return FileEntry{}, err
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return FileEntry{}, err
	}
	return FileEntry{
		SHA256: hex.EncodeToString(h.Sum(nil)),
		Size:   st.Size(),
		Mode:   strconv.FormatUint(uint64(st.Mode().Perm()), 8),
	}, nil
}

// Verify loads the manifest and checks the tree against it. It returns the manifest so
// the caller can read versions and entry points from the same trusted source.
func Verify(root string) (*Manifest, error) {
	m, err := Load(root)
	if err != nil {
		return nil, err
	}
	var problems []string
	if m.Schema != Schema {
		problems = append(problems, fmt.Sprintf("manifest schema %d (this waffled-runtime understands %d)", m.Schema, Schema))
	}
	if m.Arch != runtime.GOARCH {
		problems = append(problems, fmt.Sprintf("bundle is for %s but this machine is %s", m.Arch, runtime.GOARCH))
	}
	if m.Platform != runtime.GOOS {
		problems = append(problems, fmt.Sprintf("bundle is for %s but this machine is %s", m.Platform, runtime.GOOS))
	}
	// A schema or architecture mismatch makes the file lists meaningless — stop here
	// rather than drowning the operator in thousands of derived complaints.
	if len(problems) > 0 {
		return nil, refusal(root, problems)
	}

	files, symlinks, err := Scan(root)
	if err != nil {
		return nil, err
	}

	// Containment, checked before set equality because set equality cannot see it: a link
	// that already pointed outside the tree when the bundle was built is recorded
	// faithfully, so the manifest and the disk agree and every other rule passes. What
	// makes the bundle relocatable is that all 1,338 of its links are relative and land
	// inside it; one that escapes resolves to something real on the machine that built it
	// and to something else — or nothing — on the machine that unpacks the app.
	for _, rel := range sortedStringKeys(symlinks) {
		if escapesRoot(rel, symlinks[rel]) {
			problems = append(problems, fmt.Sprintf("symlink escapes the bundle: %s → %s", rel, symlinks[rel]))
		}
	}

	for _, rel := range sortedFileKeys(m.Files) {
		want := m.Files[rel]
		got, ok := files[rel]
		switch {
		case !ok:
			problems = append(problems, "missing file: "+rel)
		case got.SHA256 != want.SHA256:
			problems = append(problems, "changed: "+rel)
		case got.Size != want.Size:
			problems = append(problems, "size differs: "+rel)
		case execBit(got.Mode) != execBit(want.Mode):
			problems = append(problems, "exec bit differs: "+rel)
		}
	}
	for _, rel := range sortedFileKeys(files) {
		if _, ok := m.Files[rel]; !ok {
			problems = append(problems, "extra file: "+rel)
		}
	}
	for _, rel := range sortedStringKeys(m.Symlinks) {
		got, ok := symlinks[rel]
		if !ok {
			problems = append(problems, "missing symlink: "+rel)
		} else if got != m.Symlinks[rel] {
			problems = append(problems, fmt.Sprintf("symlink target differs: %s → %s (manifest: %s)", rel, got, m.Symlinks[rel]))
		}
	}
	for _, rel := range sortedStringKeys(symlinks) {
		if _, ok := m.Symlinks[rel]; !ok {
			problems = append(problems, "extra symlink: "+rel)
		}
	}
	if len(problems) > 0 {
		return nil, refusal(root, problems)
	}
	return m, nil
}

// cacheEntry remembers that a particular bundle build at a particular path verified.
type cacheEntry struct {
	Root        string `json:"root"`
	ManifestSHA string `json:"manifestSha256"`
	// FilesDigest fingerprints what was on disk at that moment — see treeDigest. An
	// entry without one was written by an older build and is never trusted.
	FilesDigest  string `json:"filesDigest"`
	BuiltAt      string `json:"builtAt"`
	GitSha       string `json:"gitSha"`
	VerifiedAt   string `json:"verifiedAt"`
	FileCount    int    `json:"fileCount"`
	SymlinkCount int    `json:"symlinkCount"`
}

// treeDigest fingerprints the bundle as it is on disk right now: the size and mtime of
// every path the manifest lists, files and symlinks alike, in a fixed order. It hashes
// no content — one lstat per entry, about 115 ms warm across the real bundle's 36,456
// files, against ~1.5 s to rehash 580 MB — but it is what makes the memo honest. A path
// that has gone missing changes the digest rather than being skipped.
func treeDigest(root string, m *Manifest) string {
	h := sha256.New()
	add := func(rel string) {
		st, err := os.Lstat(filepath.Join(root, rel))
		if err != nil {
			fmt.Fprintf(h, "%s\x00missing\n", rel)
			return
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\n", rel, st.Size(), st.ModTime().UnixNano())
	}
	for _, rel := range sortedFileKeys(m.Files) {
		add(rel)
	}
	for _, rel := range sortedStringKeys(m.Symlinks) {
		add(rel)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// VerifyCached is Verify with a memo. Hashing 580 MB across 36k files costs seconds, and
// a warm `start` should not pay it. The key is the bundle path, the sha256 of
// manifest.json, and a stat fingerprint of every path that manifest lists. The manifest
// hash alone was not enough: it changes with the build, but a file altered in place
// leaves it untouched, so any tampered binary rode through every warm start. With the
// fingerprint, a bundled file that has been changed, replaced or removed since the last
// verify misses the memo and pays the full walk — which then refuses it. It reports
// whether the answer came from the cache.
func VerifyCached(root, cachePath string) (*Manifest, bool, error) {
	manifestSHA, err := hashFile(filepath.Join(root, FileName))
	if err != nil {
		return nil, false, fmt.Errorf("read the bundle manifest: %w", err)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		absRoot = root
	}

	if raw, err := os.ReadFile(cachePath); err == nil {
		var entry cacheEntry
		if json.Unmarshal(raw, &entry) == nil &&
			entry.Root == absRoot && entry.ManifestSHA == manifestSHA.SHA256 && entry.FilesDigest != "" {
			m, err := Load(root)
			if err == nil && treeDigest(root, m) == entry.FilesDigest {
				return m, true, nil
			}
		}
	}

	m, err := Verify(root)
	if err != nil {
		return nil, false, err
	}
	entry := cacheEntry{
		Root: absRoot, ManifestSHA: manifestSHA.SHA256,
		FilesDigest: treeDigest(root, m),
		BuiltAt:     m.BuiltAt, GitSha: m.GitSha,
		VerifiedAt:   nowRFC3339(),
		FileCount:    m.FileCount,
		SymlinkCount: m.SymlinkCount,
	}
	if raw, err := json.MarshalIndent(entry, "", "  "); err == nil {
		_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
		// A cache we cannot write is a performance problem, never a correctness one.
		_ = os.WriteFile(cachePath, append(raw, '\n'), 0o644)
	}
	return m, false, nil
}

func refusal(root string, problems []string) error {
	shown := problems
	suffix := ""
	if len(problems) > maxReportedProblems {
		shown = problems[:maxReportedProblems]
		suffix = fmt.Sprintf("\n  … %d more", len(problems)-maxReportedProblems)
	}
	return fmt.Errorf("the runtime bundle at %s does not match its manifest (%d problem(s)) — "+
		"refusing to start:\n  %s%s", root, len(problems), strings.Join(shown, "\n  "), suffix)
}

// escapesRoot reports whether the symlink at rel — a POSIX path relative to the bundle
// root — would resolve outside the bundle when followed. The comparison is lexical and
// happens entirely in relative space, never against an absolute root: a bundle can sit
// under symlinks of its own (/var → /private/var on macOS, or an app in a symlinked
// checkout), and resolving through those would compare two different spellings of the
// same tree. A target that resolves to the root itself stays inside it.
//
// The twin rule lives in infra/native/bundle/manifest.mjs verify(), which is what
// `build.sh verify` runs; the two must agree, and the manifest tests pin both edges
// (root itself: allowed; absolute: never).
func escapesRoot(rel, target string) bool {
	t := filepath.ToSlash(target)
	if path.IsAbs(t) {
		return true
	}
	resolved := path.Join(path.Dir(rel), t)
	return resolved == ".." || strings.HasPrefix(resolved, "../")
}

// Only the owner-exec bit is load-bearing: a copy keeps it, while umask may alter the rest.
func execBit(mode string) bool {
	n, err := strconv.ParseUint(mode, 8, 32)
	if err != nil {
		return false
	}
	return n&0o100 != 0
}

func sortedFileKeys(m map[string]FileEntry) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedStringKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
