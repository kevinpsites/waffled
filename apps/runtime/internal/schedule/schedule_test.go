package schedule

import (
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newAgent builds an agent pointed at a throwaway LaunchAgents directory with a
// recording launchctl. Nothing in this package's tests may reach the real
// ~/Library/LaunchAgents or run launchctl: installing a nightly job on the machine
// running the suite is not a test, it is a side effect.
func newAgent(t *testing.T) (*Agent, *[][]string) {
	t.Helper()
	var calls [][]string
	a := &Agent{
		AgentsDir:  t.TempDir(),
		BinaryPath: "/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime",
		BundleDir:  "/Applications/Waffled.app/Contents/Resources/runtime",
		DataDir:    "/Users/sam/Library/Application Support/Waffled",
		LogPath:    "/Users/sam/Library/Application Support/Waffled/logs/backup.log",
		UID:        501,
		launchctl: func(args ...string) (string, error) {
			calls = append(calls, args)
			return "", nil
		},
	}
	return a, &calls
}

func TestPlistPathMatchesTheLabel(t *testing.T) {
	a, _ := newAgent(t)
	if base := filepath.Base(a.PlistPath()); base != Label+".plist" {
		t.Errorf("plist is %q, want %q — launchd requires the filename to match the label",
			base, Label+".plist")
	}
	if Label != "app.waffled.backup" {
		t.Errorf("Label = %q, want app.waffled.backup", Label)
	}
}

// The plist has to be real XML that launchd will parse — hand-built string concatenation
// is how an apostrophe in a user's name or a & in a path silently produces a plist that
// never loads.
func TestPlistIsWellFormedXML(t *testing.T) {
	a, _ := newAgent(t)
	a.DataDir = `/Users/sam & jo/Library/Application Support/Waffled`

	body, err := a.Plist()
	if err != nil {
		t.Fatalf("Plist: %v", err)
	}
	if err := xml.Unmarshal(body, new(struct {
		XMLName xml.Name `xml:"plist"`
	})); err != nil {
		t.Fatalf("the generated plist is not well-formed XML: %v\n%s", err, body)
	}
	if !strings.Contains(string(body), "&amp;") {
		t.Errorf("the ampersand in the data directory was not escaped:\n%s", body)
	}
	if !strings.HasPrefix(string(body), `<?xml`) {
		t.Errorf("the plist is missing its XML declaration:\n%s", body)
	}
	if !strings.Contains(string(body), "<!DOCTYPE plist") {
		t.Errorf("the plist is missing its DOCTYPE:\n%s", body)
	}
}

// A launchd agent gets a minimal environment and no working directory it can rely on, so
// every path in ProgramArguments must be absolute and complete. An agent that inherited
// --data from a shell would back up whichever data directory it happened to guess.
func TestPlistPinsAbsolutePathsAndTheNightlyHour(t *testing.T) {
	a, _ := newAgent(t)
	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)

	for _, want := range []string{
		"<string>" + a.BinaryPath + "</string>",
		"<string>backup</string>",
		"<string>--bundle</string>",
		"<string>--data</string>",
		"<key>StartCalendarInterval</key>",
		"<key>Hour</key>",
		"<integer>3</integer>",
		"<key>Minute</key>",
		"<integer>0</integer>",
		"<key>Label</key>",
		"<string>" + Label + "</string>",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the plist is missing %s:\n%s", want, text)
		}
	}

	// RunAtLoad must be false: installing the schedule should not kick off a dump on the
	// spot, and neither should every login. (What the value actually parses to is
	// asserted against plutil in schedule_darwin_test.go — this only pins that the key
	// is present and negative, whichever of the two empty-element spellings Go emits.)
	if i := strings.Index(text, "<key>RunAtLoad</key>"); i < 0 {
		t.Errorf("RunAtLoad is missing:\n%s", text)
	} else if rest := text[i:]; !strings.Contains(rest[:60], "<false") {
		t.Errorf("RunAtLoad should be false:\n%s", rest[:60])
	}
	// Output has to land somewhere findable, or a failing nightly backup is invisible.
	if !strings.Contains(text, a.LogPath) {
		t.Errorf("the plist does not send output to %s:\n%s", a.LogPath, text)
	}
}

func TestInstallWritesThePlistAndBootstrapsIt(t *testing.T) {
	a, calls := newAgent(t)
	if a.Installed() {
		t.Fatal("Installed() is true before anything was installed")
	}

	if err := a.Install(); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !a.Installed() {
		t.Error("Installed() is false after Install")
	}
	st, err := os.Stat(a.PlistPath())
	if err != nil {
		t.Fatalf("the plist was not written: %v", err)
	}
	if perm := st.Mode().Perm(); perm != 0o644 {
		t.Errorf("plist mode is %o, want 0644 — launchd refuses a group- or world-writable job", perm)
	}

	if len(*calls) == 0 {
		t.Fatal("launchctl was never called")
	}
	last := (*calls)[len(*calls)-1]
	if last[0] != "bootstrap" || last[1] != "gui/501" || last[2] != a.PlistPath() {
		t.Errorf("launchctl was called with %v, want bootstrap gui/501 %s", last, a.PlistPath())
	}
}

// Installing twice must not fail: someone re-running the command, or an update
// re-asserting the schedule, is the normal case. launchd refuses to bootstrap a label it
// already has, so install has to boot the old one out first.
func TestInstallIsIdempotent(t *testing.T) {
	a, calls := newAgent(t)
	if err := a.Install(); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	if err := a.Install(); err != nil {
		t.Fatalf("second Install: %v", err)
	}
	var sawBootout bool
	for _, c := range *calls {
		if c[0] == "bootout" {
			sawBootout = true
		}
	}
	if !sawBootout {
		t.Error("a re-install never booted the existing job out, so launchctl bootstrap would fail")
	}
}

func TestUninstallRemovesThePlistAndBootsItOut(t *testing.T) {
	a, calls := newAgent(t)
	if err := a.Install(); err != nil {
		t.Fatal(err)
	}
	*calls = nil

	if err := a.Uninstall(); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if a.Installed() {
		t.Error("the plist is still there after Uninstall")
	}
	if len(*calls) == 0 || (*calls)[0][0] != "bootout" {
		t.Errorf("launchctl calls %v, want bootout first", *calls)
	}
	if (*calls)[0][1] != "gui/501/"+Label {
		t.Errorf("bootout target %q, want gui/501/%s", (*calls)[0][1], Label)
	}
}

// Uninstalling something that was never installed is what a user does after an
// uninstall, or what an updater does defensively. It must be quiet, not an error.
func TestUninstallWhenNothingIsInstalled(t *testing.T) {
	a, _ := newAgent(t)
	if err := a.Uninstall(); err != nil {
		t.Errorf("Uninstall with nothing installed: %v", err)
	}
}

// A bootstrap that fails must not leave the plist behind. Installed() is a bare os.Stat,
// so a leftover file makes `doctor`, `status` and the menu bar all report a nightly
// backup that launchd never loaded and that will never run — the exact failure the
// schedule exists to make visible, reported as success indefinitely.
func TestFailedBootstrapRemovesThePlist(t *testing.T) {
	a, _ := newAgent(t)
	a.launchctl = func(args ...string) (string, error) {
		if args[0] == "bootstrap" {
			return "Bootstrap failed: 5: Input/output error", errors.New("exit status 5")
		}
		return "", nil
	}

	err := a.Install()
	if err == nil {
		t.Fatal("Install reported success despite launchctl bootstrap failing")
	}
	if a.Installed() {
		t.Error("the plist is still on disk after a failed bootstrap, so everything that " +
			"asks Installed() will report a nightly backup that was never loaded")
	}
}

// Loaded() is the cross-check `doctor` runs: the question "is the job actually there?"
// which only launchd can answer. It is deliberately NOT what Installed() asks — `status`
// polls that once a second and cannot afford a launchctl fork.
func TestLoadedAsksLaunchdForTheJob(t *testing.T) {
	a, calls := newAgent(t)
	loaded, err := a.Loaded()
	if err != nil {
		t.Fatalf("Loaded: %v", err)
	}
	if !loaded {
		t.Error("Loaded() is false though launchctl print succeeded")
	}
	if len(*calls) != 1 {
		t.Fatalf("launchctl calls %v, want exactly one", *calls)
	}
	if got := (*calls)[0]; got[0] != "print" || got[1] != "gui/501/"+Label {
		t.Errorf("launchctl was called with %v, want print gui/501/%s", got, Label)
	}
}

func TestLoadedReportsAJobLaunchdDoesNotHave(t *testing.T) {
	a, _ := newAgent(t)
	a.launchctl = func(...string) (string, error) {
		return "Could not find service \"" + Label + "\" in domain for gui", errors.New("exit status 113")
	}

	loaded, err := a.Loaded()
	if loaded {
		t.Error("Loaded() is true though launchctl could not find the job")
	}
	if err == nil {
		t.Fatal("Loaded() gave no reason for the job being missing")
	}
	// The detail is what `doctor` prints; without launchctl's own words nobody can tell a
	// job that was never loaded from a launchctl that would not run at all.
	if !strings.Contains(err.Error(), "Could not find service") {
		t.Errorf("the error drops launchctl's explanation: %v", err)
	}
}

// The plist is written atomically — temp file, fsync, rename — so a crash part-way
// through leaves either the old job file or the new one, never a truncated one launchd
// refuses at the next login while Installed() still reports it as there. Atomicity itself
// needs fault injection to observe; what this pins is that the dance leaves nothing
// behind, a stray temp file in ~/Library/LaunchAgents being the visible symptom of
// getting it wrong.
func TestInstallLeavesNoTemporaryFileBehind(t *testing.T) {
	a, _ := newAgent(t)
	if err := a.Install(); err != nil {
		t.Fatalf("Install: %v", err)
	}
	entries, err := os.ReadDir(a.AgentsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != Label+".plist" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("LaunchAgents holds %v, want only %s.plist", names, Label)
	}
}
