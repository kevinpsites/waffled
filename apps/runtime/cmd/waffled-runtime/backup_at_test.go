package main

import (
	"strings"
	"testing"
)

// A time launchd could not run has to be refused before anything is installed — and
// before the supervisor is built, so the message is about the time rather than about a
// bundle this test has no business needing.
func TestBackupRefusesATimeItCouldNotSchedule(t *testing.T) {
	for _, at := range []string{"3pm", "24:00", "03:0x", "noon"} {
		err := run([]string{"backup", "--install-schedule", "--at", at})
		if err == nil {
			t.Errorf("--at %q was accepted", at)
			continue
		}
		if !strings.Contains(err.Error(), at) {
			t.Errorf("--at %q was refused without naming it: %v", at, err)
		}
	}
}

// `--at` on its own would look like it had changed the nightly time while changing
// nothing at all: the schedule is only ever written by --install-schedule.
func TestBackupRefusesAtWithoutInstallSchedule(t *testing.T) {
	if err := run([]string{"backup", "--at", "03:00"}); err == nil {
		t.Fatal("--at without --install-schedule was accepted")
	}
	if err := run([]string{"backup", "--uninstall-schedule", "--at", "03:00"}); err == nil {
		t.Fatal("--at with --uninstall-schedule was accepted")
	}
}
