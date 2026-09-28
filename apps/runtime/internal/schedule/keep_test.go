package schedule

import (
	"os"
	"strings"
	"testing"
)

// The retention a household chose has to travel with the job launchd runs: the nightly
// backup is `waffled-runtime backup` with whatever is in ProgramArguments and nothing
// else, so a keep that is not in there is a keep that never happens.
func TestPlistCarriesTheChosenRetention(t *testing.T) {
	a, _ := newAgent(t)
	a.Keep = 30

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "<string>--keep</string>\n\t\t\t<string>30</string>") {
		t.Errorf("the plist does not pass --keep 30 to the backup it runs:\n%s", body)
	}
}

// An agent nobody gave a retention keeps the runtime's own default, and says nothing
// about it — the plist of every schedule installed before this was configurable.
func TestPlistOmitsKeepWhenNoneWasChosen(t *testing.T) {
	a, _ := newAgent(t)
	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "--keep") {
		t.Errorf("an agent with no retention set wrote one anyway:\n%s", body)
	}
}

func TestPlistRefusesARetentionThatKeepsNothing(t *testing.T) {
	a, _ := newAgent(t)
	a.Keep = -1
	if _, err := a.Plist(); err == nil {
		t.Fatal("the plist was rendered with a negative retention")
	}
}

// The installed plist is the record of the retention, as it is of the time — which is
// what lets a later re-install and `status` both read back what was chosen.
func TestScheduledKeepReadsTheInstalledPlist(t *testing.T) {
	a, _ := newAgent(t)
	a.Keep = 90
	if err := a.Install(); err != nil {
		t.Fatal(err)
	}
	keep, err := a.ScheduledKeep()
	if err != nil {
		t.Fatal(err)
	}
	if keep != 90 {
		t.Errorf("ScheduledKeep = %d, want 90", keep)
	}
}

func TestScheduledKeepIsZeroForAScheduleThatNamesNone(t *testing.T) {
	a, _ := newAgent(t)
	if err := a.Install(); err != nil {
		t.Fatal(err)
	}
	keep, err := a.ScheduledKeep()
	if err != nil {
		t.Fatal(err)
	}
	if keep != 0 {
		t.Errorf("ScheduledKeep = %d for a plist with no --keep, want 0 (the default)", keep)
	}
}

func TestScheduledKeepFailsWithNoPlist(t *testing.T) {
	a, _ := newAgent(t)
	if keep, err := a.ScheduledKeep(); err == nil {
		t.Errorf("ScheduledKeep on a Mac with no schedule returned %d", keep)
	}
}

// A --keep that is not a positive count is a plist somebody edited by hand. Reading it
// as the default would report a retention the job does not run with — the job itself
// would refuse to start.
func TestScheduledKeepFailsClosedOnAValueThatIsNotACount(t *testing.T) {
	a, _ := newAgent(t)
	for _, bad := range []string{"many", "0", "-3", ""} {
		body := `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key>` +
			`<array><string>backup</string><string>--keep</string><string>` + bad +
			`</string></array></dict></plist>`
		if err := os.WriteFile(a.PlistPath(), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if keep, err := a.ScheduledKeep(); err == nil {
			t.Errorf("--keep %q was read as %d", bad, keep)
		}
	}
}
