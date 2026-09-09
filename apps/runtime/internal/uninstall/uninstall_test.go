package uninstall

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
)

// The real launchd agent must satisfy the interface the command takes, or the seam the
// tests use would be testing something the binary never runs.
var _ ScheduleAgent = (*schedule.Agent)(nil)

// fakeAgent stands in for *schedule.Agent. A real one cannot be used here: Uninstall
// boots out a launchd LABEL (gui/<uid>/app.waffled.backup), so pointing it at a temp
// AgentsDir would still unload the nightly backup of whoever runs the suite.
type fakeAgent struct {
	path      string
	uninstall int
}

func (f *fakeAgent) PlistPath() string { return f.path }

func (f *fakeAgent) Installed() bool {
	_, err := os.Stat(f.path)
	return err == nil
}

func (f *fakeAgent) Uninstall() error {
	f.uninstall++
	if err := os.Remove(f.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// files are what a lived-in data directory holds, with sizes the size walk must add up.
var files = map[string]string{
	"config.env":           "LOCAL_JWT_SECRET=abc\n",
	"runtime.json":         "", // written through rtstate below
	"postgres/PG_VERSION":  "16\n",
	"media/photo.jpg":      strings.Repeat("j", 4096),
	"backups/nightly.dump": strings.Repeat("d", 512),
	"logs/api.log":         "listening\n",
	"pids/supervisor.pid":  "4242\n",
	"pids/bonjour.pid":     "4243\n",
	"bonjour.json":         "{}\n",
	"bundle-verified.json": "{}\n",
	"powersync/.probes/ok": "1\n",
	"caddy/data/keep":      "1\n",
}

// fixture lays out a data root, a plist and a fallback socket directory outside the
// root, and returns the options a test can vary.
func fixture(t *testing.T) (Options, *fakeAgent, int64) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Application Support", "Waffled")
	layout := datadir.At(root)

	var wantBytes int64
	for rel, body := range files {
		if rel == "runtime.json" {
			continue
		}
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		wantBytes += int64(len(body))
	}

	// The size walk must not follow symlinks: a link into somebody's Photos library
	// would otherwise be reported as the household's own data.
	outside := filepath.Join(t.TempDir(), "huge")
	if err := os.WriteFile(outside, []byte(strings.Repeat("x", 100000)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "media", "linked.jpg")); err != nil {
		t.Fatal(err)
	}

	// A data path too long for a unix socket puts Postgres's socket in a temp directory
	// outside the root, and runtime.json is the only record of where.
	socketDir, err := os.MkdirTemp("", datadir.SocketDirPrefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(socketDir) })
	if err := os.WriteFile(filepath.Join(socketDir, ".s.PGSQL.5432"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rtstate.Save(layout.RuntimeJSON, &rtstate.State{SocketDir: socketDir}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(layout.RuntimeJSON)
	if err != nil {
		t.Fatal(err)
	}
	wantBytes += info.Size()

	agent := &fakeAgent{path: filepath.Join(t.TempDir(), schedule.Label+".plist")}
	if err := os.WriteFile(agent.path, []byte("<plist/>\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		Layout: layout,
		Agent:  agent,
		Log:    &strings.Builder{},
		// Nothing is running unless a test says so.
		alive:  func(int) bool { return false },
		signal: func(int, syscall.Signal) error { return nil },
	}
	return opts, agent, wantBytes
}

func item(t *testing.T, r Report, kind string) Item {
	t.Helper()
	for _, it := range r.Items {
		if it.Kind == kind {
			return it
		}
	}
	t.Fatalf("no %q item in the report; got %+v", kind, r.Items)
	return Item{}
}

// snapshot records every path under dir with its size, so a dry run can be proven to
// have changed nothing at all.
func snapshot(t *testing.T, dir string) map[string]int64 {
	t.Helper()
	out := map[string]int64{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		out[path] = info.Size()
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDryRunListsEveryItemAndChangesNothing(t *testing.T) {
	opts, agent, wantBytes := fixture(t)
	opts.DryRun = true
	before := snapshot(t, opts.Layout.Root)

	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if report.Schema != 1 {
		t.Errorf("schema = %d, want 1", report.Schema)
	}
	if report.DataDir != opts.Layout.Root {
		t.Errorf("dataDir = %q, want %q", report.DataDir, opts.Layout.Root)
	}
	if report.DataSizeBytes != wantBytes {
		t.Errorf("dataSizeBytes = %d, want %d (symlinks must not be followed)",
			report.DataSizeBytes, wantBytes)
	}
	for _, kind := range []string{"schedule", "bonjour", "pidfiles", "socket", "data"} {
		it := item(t, report, kind)
		if !it.Present {
			t.Errorf("%s: present = false, want true", kind)
		}
		if it.Path == "" {
			t.Errorf("%s: no path", kind)
		}
	}
	if got := item(t, report, "data").Action; got != "keep" {
		t.Errorf("data action = %q, want keep without --delete-data", got)
	}
	if got := item(t, report, "data").SizeBytes; got != wantBytes {
		t.Errorf("data sizeBytes = %d, want %d", got, wantBytes)
	}
	for _, kind := range []string{"schedule", "bonjour", "pidfiles", "socket"} {
		if got := item(t, report, kind).Action; got != "remove" {
			t.Errorf("%s action = %q, want remove", kind, got)
		}
	}
	if agent.uninstall != 0 {
		t.Errorf("a dry run unloaded the launchd job %d time(s)", agent.uninstall)
	}
	after := snapshot(t, opts.Layout.Root)
	if len(before) != len(after) {
		t.Fatalf("a dry run changed the tree: %d paths before, %d after", len(before), len(after))
	}
	for path, size := range before {
		if after[path] != size {
			t.Errorf("a dry run changed %s", path)
		}
	}
	if !agent.Installed() {
		t.Error("a dry run removed the plist")
	}
}

func TestWithoutDeleteDataTheRootSurvivesAndTheScheduleIsGone(t *testing.T) {
	opts, agent, _ := fixture(t)
	socketDir := item(t, mustInspect(t, opts), "socket").Path

	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if _, err := os.Stat(opts.Layout.Root); err != nil {
		t.Fatalf("the data root was removed without --delete-data: %v", err)
	}
	for _, rel := range []string{"config.env", "postgres/PG_VERSION", "media/photo.jpg", "backups/nightly.dump"} {
		if _, err := os.Stat(filepath.Join(opts.Layout.Root, rel)); err != nil {
			t.Errorf("%s was removed: %v", rel, err)
		}
	}
	if agent.uninstall != 1 {
		t.Errorf("the launchd job was unloaded %d time(s), want 1", agent.uninstall)
	}
	if agent.Installed() {
		t.Error("the plist is still on disk")
	}
	if _, err := os.Stat(opts.Layout.Pids); !os.IsNotExist(err) {
		t.Errorf("pids/ survived: %v", err)
	}
	if _, err := os.Stat(opts.Layout.BonjourState); !os.IsNotExist(err) {
		t.Errorf("bonjour.json survived: %v", err)
	}
	if _, err := os.Stat(socketDir); !os.IsNotExist(err) {
		t.Errorf("the postgres socket directory survived: %v", err)
	}
	if got := item(t, report, "data").Action; got != "keep" {
		t.Errorf("data action = %q, want keep", got)
	}
}

func TestDeleteDataRemovesTheRoot(t *testing.T) {
	opts, _, wantBytes := fixture(t)
	opts.DeleteData = true

	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := os.Stat(opts.Layout.Root); !os.IsNotExist(err) {
		t.Fatalf("the data root survived --delete-data: %v", err)
	}
	if got := item(t, report, "data").Action; got != "remove" {
		t.Errorf("data action = %q, want remove", got)
	}
	if got := item(t, report, "data").SizeBytes; got != wantBytes {
		t.Errorf("data sizeBytes = %d, want the size measured before deleting (%d)",
			got, wantBytes)
	}
}

func TestRefusesWhileASupervisorIsRunning(t *testing.T) {
	opts, agent, _ := fixture(t)
	opts.alive = func(pid int) bool { return pid == 4242 }

	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("Run succeeded while a supervisor was running; want a refusal")
	}
	if agent.uninstall != 0 {
		t.Error("the refusal still unloaded the launchd job")
	}
	if _, err := os.Stat(opts.Layout.Pids); err != nil {
		t.Errorf("the refusal still removed pids/: %v", err)
	}
}

func TestDryRunDoesNotRefuseWhileRunning(t *testing.T) {
	opts, _, _ := fixture(t)
	opts.DryRun = true
	opts.alive = func(pid int) bool { return pid == 4242 }

	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("a dry run refused while the server was running: %v", err)
	}
	if !strings.Contains(strings.ToLower(item(t, report, "pidfiles").Detail), "running") {
		t.Errorf("the plan does not say the server is running: %q", item(t, report, "pidfiles").Detail)
	}
}

func TestYesStopsTheRunningSupervisorFirst(t *testing.T) {
	opts, _, _ := fixture(t)
	opts.Yes = true
	stopped := false
	var sent []syscall.Signal
	opts.alive = func(pid int) bool { return pid == 4242 && !stopped }
	opts.signal = func(pid int, sig syscall.Signal) error {
		if pid != 4242 {
			t.Errorf("signalled pid %d, want the supervisor 4242", pid)
		}
		sent = append(sent, sig)
		stopped = true
		return nil
	}
	log := &strings.Builder{}
	opts.Log = log

	if _, err := Run(context.Background(), opts); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(sent) == 0 || sent[0] != syscall.SIGTERM {
		t.Errorf("signals sent = %v, want SIGTERM first", sent)
	}
	if !strings.Contains(strings.ToLower(log.String()), "stop") {
		t.Errorf("--yes did not say it stopped the server; log was %q", log.String())
	}
	if _, err := os.Stat(opts.Layout.Pids); !os.IsNotExist(err) {
		t.Errorf("pids/ survived: %v", err)
	}
}

func TestSecondRunIsANoOp(t *testing.T) {
	opts, _, _ := fixture(t)
	opts.DeleteData = true
	if _, err := Run(context.Background(), opts); err != nil {
		t.Fatalf("first Run: %v", err)
	}

	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	for _, it := range report.Items {
		if it.Present {
			t.Errorf("%s is still reported present on the second run", it.Kind)
		}
	}
	if report.DataSizeBytes != 0 {
		t.Errorf("dataSizeBytes = %d after the data was deleted, want 0", report.DataSizeBytes)
	}
}

func TestTextSaysWhatIsKept(t *testing.T) {
	opts, _, _ := fixture(t)
	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	text := report.Text()
	if !strings.Contains(text, "kept") {
		t.Errorf("the output never says \"kept\":\n%s", text)
	}
	if !strings.Contains(text, opts.Layout.Root) {
		t.Errorf("the output does not name the data directory that survived:\n%s", text)
	}
	if !strings.Contains(text, "--delete-data") {
		t.Errorf("the output does not say how to delete the data:\n%s", text)
	}
}

// A run with nothing installed must not fork launchctl at all: uninstalling boots out a
// label, and doing that when we installed nothing is somebody else's job to lose.
func TestAnAbsentScheduleIsNotUnloaded(t *testing.T) {
	opts, agent, _ := fixture(t)
	if err := os.Remove(agent.path); err != nil {
		t.Fatal(err)
	}
	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if agent.uninstall != 0 {
		t.Errorf("launchctl was run for a schedule that was not installed")
	}
	if item(t, report, "schedule").Present {
		t.Error("an absent schedule is reported present")
	}
}

func mustInspect(t *testing.T, opts Options) Report {
	t.Helper()
	return Inspect(opts)
}

// A process owned by somebody else — Waffled started by another account on a shared Mac,
// or by a root LaunchDaemon — is still running. Signal 0 answers EPERM for it, not nil,
// and reading that as "dead" would let uninstall walk straight past its own refusal and
// delete the data root out from under a live Postgres.
func TestProcessAliveCountsAProcessOwnedBySomebodyElse(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: every signal is permitted, so there is no EPERM to observe")
	}
	// pid 1 is launchd on macOS and init on Linux, always running and never ours.
	if !processAlive(1) {
		t.Error("processAlive(1) = false; a running process we may not signal is still running")
	}
}

// --delete-data is one flag away from an rm -rf of whatever --data named, and a person
// reaching for it is usually in a hurry. A directory with none of Waffled's own marks in
// it is not the data directory, whatever the flag said.
func TestDeleteDataRefusesADirectoryThatIsNotAWaffledDataFolder(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "taxes.pdf"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := Options{
		Layout:     datadir.At(home),
		DeleteData: true,
		Log:        &strings.Builder{},
	}

	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("Run deleted a directory with nothing of Waffled's in it; want a refusal")
	}
	if _, err := os.Stat(filepath.Join(home, "taxes.pdf")); err != nil {
		t.Errorf("the refusal still deleted the contents: %v", err)
	}
}

// A data root moved to another volume and left as a symlink behind — the documented way
// to keep a large household off the boot disk. Walking it without following the link
// measures nothing, and removing it takes the link and leaves every byte of the cluster
// on the volume while the output claims the data was deleted.
func TestASymlinkedDataRootIsMeasuredAndDeletedThrough(t *testing.T) {
	target := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(filepath.Join(target, "postgres"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "config.env"), []byte(strings.Repeat("s", 700)), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "Waffled")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	opts := Options{Layout: datadir.At(link), DeleteData: true, Log: &strings.Builder{}}
	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if report.DataSizeBytes < 700 {
		t.Errorf("dataSizeBytes = %d, want the 700 bytes on the other side of the symlink",
			report.DataSizeBytes)
	}
	if _, err := os.Stat(filepath.Join(target, "config.env")); !os.IsNotExist(err) {
		t.Errorf("the data behind the symlink survived a run that reported it removed: %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Errorf("the dangling symlink was left behind: %v", err)
	}
}
