package supervisor

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
)

// fakeBundle is the smallest tree that passes manifest verification: one file, plus a
// manifest describing exactly it. `New` verifies before it does anything else, and none
// of the rules below need a binary that runs.
func fakeBundle(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "waffled-runtime"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	files, symlinks, err := manifest.Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	m := manifest.Manifest{
		Schema: 1, Name: "waffled-runtime", Arch: "arm64", Platform: "darwin",
		WaffledVersion: "0.0.0-test",
		FileCount:      len(files), SymlinkCount: len(symlinks),
		Files: files, Symlinks: symlinks,
	}
	raw, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, manifest.FileName), append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// testLog writes the supervisor's narration into the test's own output. (`tw` in the
// integration file is the same idea, but that file is behind a build tag.)
type testLog struct{ t *testing.T }

func (w *testLog) Write(p []byte) (int, error) {
	w.t.Logf("%s", p)
	return len(p), nil
}

func emptyDataDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "Application Support", "Waffled")
}

// layoutFor is emptyDataDir's layout with the directories made, for a test that has to
// put something in config.env before the first construction.
func layoutFor(t *testing.T, data string) datadir.Layout {
	t.Helper()
	l := datadir.At(data)
	if err := l.Ensure(); err != nil {
		t.Fatal(err)
	}
	return l
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// freePortForTest asks the OS for one and gives it straight back, which is the same
// question `ports.IsFree` answers.
func freePortForTest(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

// The whole point of the read-only mode. The Mac app polls `status` the instant it
// launches — before the setup window exists, let alone before anyone has typed a port —
// and `status` builds a supervisor. If that construction allocates and SAVES ports, the
// household's first allocation has already happened by the time they choose one, and the
// `HTTP_PORT` the setup screen writes is read on a run that will never be a first run.
func TestAReadOnlyConstructionOnAnEmptyDataDirectoryWritesNothing(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)
	layout := datadir.At(data)

	if _, err := New(Options{BundleDir: bundle, DataDir: data, ReadOnly: true,
		Log: NewLogger(&testLog{t}, false)}); err != nil {
		t.Fatal(err)
	}

	if exists(layout.RuntimeJSON) {
		t.Errorf("%s was written by a read-only construction", layout.RuntimeJSON)
	}
	if exists(layout.ConfigEnv) {
		t.Errorf("%s was written by a read-only construction — the secrets in it would be "+
			"the household's, generated before anyone said yes", layout.ConfigEnv)
	}
}

// The Time Machine exclusion is a write whose "already done" memo lives in the
// runtime.json a read-only construction does not save. Doing it anyway would fork tmutil
// on every one of the menu bar's two-second polls and remember nothing.
func TestAReadOnlyConstructionDoesNotExcludeAHouseholdThatDoesNotExist(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)

	s, err := New(Options{BundleDir: bundle, DataDir: data, ReadOnly: true,
		Log: NewLogger(&testLog{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	if s.state.BackupExcluded {
		t.Error("a read-only construction should leave the exclusion to the first start")
	}
}

// And the payoff: the port a household typed is the port they get, because the first
// `start` is genuinely the first allocation.
func TestTheFirstStartIsTheFirstAllocationSoHTTPPortIsHonoured(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)
	layout := datadir.At(data)

	// The app's launch poll.
	if _, err := New(Options{BundleDir: bundle, DataDir: data, ReadOnly: true,
		Log: NewLogger(&testLog{t}, false)}); err != nil {
		t.Fatal(err)
	}
	// Then the setup screen's `config set`, then the click.
	free := freePortForTest(t)
	if err := os.MkdirAll(layout.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	env.Set(KeyHTTPPort, itoa(free))
	if err := env.Save(layout.ConfigEnv); err != nil {
		t.Fatal(err)
	}

	s, err := New(Options{BundleDir: bundle, DataDir: data, Log: NewLogger(&testLog{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.state.Ports.Public; got != free {
		t.Errorf("public port = %d, want the %d that was asked for", got, free)
	}
}

// A writing construction is still the one that records the household. Without this the
// read-only change would simply have stopped ports being saved at all.
func TestAWritingConstructionOnAnEmptyDataDirectoryRecordsIt(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)
	layout := datadir.At(data)

	if _, err := New(Options{BundleDir: bundle, DataDir: data,
		Log: NewLogger(&testLog{t}, false)}); err != nil {
		t.Fatal(err)
	}
	if !exists(layout.RuntimeJSON) {
		t.Errorf("%s should have been written", layout.RuntimeJSON)
	}
	if !exists(layout.ConfigEnv) {
		t.Errorf("%s should have been written", layout.ConfigEnv)
	}
}

// An install that already exists is untouched by the change: read-only or not, its files
// are there, and its published port survives an HTTP_PORT that disagrees. That last part
// is the round-1 fix, which had no test of its own.
func TestAnExistingInstallKeepsThePortItPublished(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)
	layout := datadir.At(data)

	first, err := New(Options{BundleDir: bundle, DataDir: data, Log: NewLogger(&testLog{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	published := first.state.Ports.Public

	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	env.Set(KeyHTTPPort, itoa(freePortForTest(t)))
	if err := env.Save(layout.ConfigEnv); err != nil {
		t.Fatal(err)
	}

	for _, readOnly := range []bool{false, true} {
		s, err := New(Options{BundleDir: bundle, DataDir: data, ReadOnly: readOnly,
			TolerateConflicts: true, Log: NewLogger(&testLog{t}, false)})
		if err != nil {
			t.Fatal(err)
		}
		if got := s.state.Ports.Public; got != published {
			t.Errorf("readOnly=%v: public port moved from %d to %d — every device in the "+
				"house points at the first one", readOnly, published, got)
		}
	}
}
