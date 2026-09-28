package supervisor

import (
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
)

// `scheduleAt` returns "" when the installed plist will not parse — a time nobody's
// launchd will honour is worse than no time — and doctor's OK branch printed it straight
// into "at %s (%s)", giving "at  (app.waffled.backup)".
func TestTheScheduleLineNeverShowsABlankTime(t *testing.T) {
	line := scheduleOKDetail("")
	if strings.Contains(line, "at  ") || strings.Contains(line, "at (") {
		t.Errorf("a blank time reached the sentence: %q", line)
	}
	if !strings.Contains(line, "unreadable") {
		t.Errorf("it should say the time could not be read, got %q", line)
	}
}

func TestTheScheduleLineNamesTheTimeWhenThereIsOne(t *testing.T) {
	line := scheduleOKDetail("03:00")
	if !strings.Contains(line, "03:00") {
		t.Errorf("the time should be in the sentence, got %q", line)
	}
}

// `settlePorts` parsed HTTP_PORT before it knew whether this was a first run, so a value
// that is not a number refused `start` on an install that has been running for a year —
// contradicting the rule that on a settled install the setting does nothing at all.
func TestAnUnparseableHTTPPortDoesNotBreakASettledInstall(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)

	first, err := New(Options{BundleDir: bundle, DataDir: data, Log: NewLogger(&testLog{t}, false)})
	if err != nil {
		t.Fatal(err)
	}
	published := first.state.Ports.Public

	env, err := configenv.Load(first.plan.Layout.ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	env.Set(KeyHTTPPort, "eighty")
	if err := env.Save(first.plan.Layout.ConfigEnv); err != nil {
		t.Fatal(err)
	}

	again, err := New(Options{BundleDir: bundle, DataDir: data, TolerateConflicts: true,
		Log: NewLogger(&testLog{t}, false)})
	if err != nil {
		t.Fatalf("a settled install refused to construct over a setting it ignores: %v", err)
	}
	if got := again.state.Ports.Public; got != published {
		t.Errorf("public port = %d, want the published %d", got, published)
	}
}

// On a FIRST run it is still a refusal: that is the one time the value is acted on, and
// silently ignoring a typo would hand the household a port they did not ask for.
func TestAnUnparseableHTTPPortIsStillRefusedOnAFirstRun(t *testing.T) {
	bundle, data := fakeBundle(t), emptyDataDir(t)
	layout := layoutFor(t, data)

	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	env.Set(KeyHTTPPort, "eighty")
	if err := env.Save(layout.ConfigEnv); err != nil {
		t.Fatal(err)
	}

	if _, err := New(Options{BundleDir: bundle, DataDir: data,
		Log: NewLogger(&testLog{t}, false)}); err == nil {
		t.Fatal("a first run should refuse a port it cannot read")
	}
}
