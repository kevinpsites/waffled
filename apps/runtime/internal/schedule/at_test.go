package schedule

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestParseAtReadsATwentyFourHourTime(t *testing.T) {
	for _, c := range []struct {
		in     string
		h, min int
	}{
		{"00:00", 0, 0},
		{"1:00", 1, 0},
		{"01:00", 1, 0},
		{"03:00", 3, 0},
		{"12:00", 12, 0},
		{"12:30", 12, 30},
		{"23:59", 23, 59},
	} {
		h, m, err := ParseAt(c.in)
		if err != nil {
			t.Errorf("ParseAt(%q): %v", c.in, err)
			continue
		}
		if h != c.h || m != c.min {
			t.Errorf("ParseAt(%q) = %d:%d, want %d:%d", c.in, h, m, c.h, c.min)
		}
	}
}

func TestParseAtRefusesWhatLaunchdCouldNotRun(t *testing.T) {
	// "٣:٠٠" is Arabic-Indic digits: strconv.Atoi refuses them, and a parser that used
	// unicode.IsDigit would not.
	for _, in := range []string{
		"", "3", "3am", "3:00 AM", "24:00", "23:60", "-1:00", "03:0x", "03:00:00", "٣:٠٠", " 3:00",
	} {
		if h, m, err := ParseAt(in); err == nil {
			t.Errorf("ParseAt(%q) was accepted as %d:%d", in, h, m)
		}
	}
}

func TestPlistCarriesTheChosenHour(t *testing.T) {
	a, _ := newAgent(t)
	a.At = "12:30"

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{"<integer>12</integer>", "<integer>30</integer>"} {
		if !strings.Contains(text, want) {
			t.Errorf("the plist is missing %s:\n%s", want, text)
		}
	}
}

// Every caller before this change built an Agent with no time on it, and 03:00 is the
// documented default. `At` is a string rather than two ints precisely so that a
// household choosing midnight is not read as one that chose nothing.
func TestAnAgentWithNoTimeSetStillMeansTheDefaultNightlyTime(t *testing.T) {
	a := &Agent{AgentsDir: t.TempDir(), BinaryPath: "/x/waffled-runtime", UID: 501}
	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("<integer>%d</integer>", DefaultHour)
	if !strings.Contains(string(body), want) {
		t.Errorf("an agent with no time set does not schedule %02d:%02d:\n%s",
			DefaultHour, DefaultMinute, body)
	}
}

// The installed plist is the only record of the hour, which is what lets `status` report
// the time a household actually chose with no second file to drift out of step.
func TestScheduledAtReadsTheInstalledPlist(t *testing.T) {
	a, _ := newAgent(t)
	a.At = "01:05"
	if err := a.Install(); err != nil {
		t.Fatal(err)
	}
	at, err := a.ScheduledAt()
	if err != nil {
		t.Fatal(err)
	}
	if at != "01:05" {
		t.Errorf("ScheduledAt = %q, want 01:05", at)
	}
}

func TestScheduledAtFailsWithNoPlist(t *testing.T) {
	a, _ := newAgent(t)
	if at, err := a.ScheduledAt(); err == nil {
		t.Errorf("ScheduledAt on a Mac with no schedule returned %q", at)
	}
}

func TestScheduledAtFailsClosedOnAnUnreadablePlist(t *testing.T) {
	a, _ := newAgent(t)
	if err := os.WriteFile(a.PlistPath(), []byte("<plist><dict><key>Label"), 0o644); err != nil {
		t.Fatal(err)
	}
	if at, err := a.ScheduledAt(); err == nil {
		t.Errorf("a truncated plist was read as %q", at)
	}
}

// A plist with no StartCalendarInterval at all is not "midnight": it is a job that runs
// only when launchd is told to, and reporting 00:00 would invent a nightly backup.
func TestScheduledAtFailsWhenThePlistNamesNoTime(t *testing.T) {
	a, _ := newAgent(t)
	body := `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>` + Label + `</string></dict></plist>`
	if err := os.WriteFile(a.PlistPath(), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if at, err := a.ScheduledAt(); err == nil {
		t.Errorf("a plist with no StartCalendarInterval was read as %q", at)
	}
}

func TestMidnightIsNotTheSameAsUnset(t *testing.T) {
	a, _ := newAgent(t)
	a.At = "00:00"
	if err := a.Install(); err != nil {
		t.Fatal(err)
	}
	at, err := a.ScheduledAt()
	if err != nil {
		t.Fatal(err)
	}
	if at != "00:00" {
		t.Errorf("ScheduledAt = %q, want 00:00 — a chosen midnight became the default", at)
	}
}

func TestPlistRefusesATimeItCouldNotSchedule(t *testing.T) {
	a, _ := newAgent(t)
	a.At = "tea time"
	if _, err := a.Plist(); err == nil {
		t.Fatal("the plist was rendered with a time launchd could not run")
	}
}
