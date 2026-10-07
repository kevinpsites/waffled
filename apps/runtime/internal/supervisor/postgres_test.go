package supervisor

import (
	"io"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// countingExclusion swaps the two tmutil-backed hooks for counters, and puts the real
// ones back when the test ends. Nothing in this package's tests may run tmutil against
// the machine holding the suite.
func countingExclusion(t *testing.T) (asked, marked *int) {
	t.Helper()
	var a, m int
	realIs, realExclude := isExcludedFromBackup, excludeFromBackup
	isExcludedFromBackup = func(string) bool { a++; return true }
	excludeFromBackup = func(string) error { m++; return nil }
	t.Cleanup(func() { isExcludedFromBackup, excludeFromBackup = realIs, realExclude })
	return &a, &m
}

func exclusionSupervisor(t *testing.T, excluded bool) *Supervisor {
	t.Helper()
	root := t.TempDir()
	return &Supervisor{
		log:   NewLogger(io.Discard, true),
		state: &rtstate.State{BackupExcluded: excluded},
		plan:  services.Plan{Layout: datadir.At(root)},
	}
}

// The Time Machine exclusion is a settled question: once PGDATA is marked, the answer is
// remembered in runtime.json. New() asserts it on construction — and `status` constructs
// a Supervisor on every poll, so asking tmutil again there is a process fork per second
// for the menu-bar app. The memo has to be trusted outright; the live re-check belongs in
// `doctor`, which is the command that exists to re-ask settled questions.
//
// excludeDataFromTimeMachine is supervisor.go:206's only caller, so what this pins about
// the function is exactly what holds for New().
func TestExclusionMemoIsTrustedWithoutAskingTmutil(t *testing.T) {
	asked, marked := countingExclusion(t)
	s := exclusionSupervisor(t, true)

	s.excludeDataFromTimeMachine()

	if *asked != 0 {
		t.Errorf("tmutil isexcluded ran %d time(s) despite the memo — that is a process fork "+
			"on every status poll", *asked)
	}
	if *marked != 0 {
		t.Errorf("tmutil addexclusion ran %d time(s) for an already-excluded directory", *marked)
	}
	if !s.state.BackupExcluded {
		t.Error("the memo was cleared by a call that asked nothing")
	}
}

// The other half: an install that predates the memo, or one where tmutil failed once,
// still gets PGDATA excluded on its next start.
func TestExclusionIsAssertedWhenTheMemoIsUnset(t *testing.T) {
	_, marked := countingExclusion(t)
	s := exclusionSupervisor(t, false)

	s.excludeDataFromTimeMachine()

	if *marked != 1 {
		t.Errorf("tmutil addexclusion ran %d time(s), want 1", *marked)
	}
	if !s.state.BackupExcluded {
		t.Error("the exclusion succeeded but was not remembered, so it will be re-asked forever")
	}
}
