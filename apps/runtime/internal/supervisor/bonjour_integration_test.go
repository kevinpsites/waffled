//go:build integration

// The one dynamic thing about the advertisement, against the real bundle: an install
// with no household yet advertises `setup=1`, and the moment the wizard creates one the
// name and the flag both change — without anybody restarting the server.
//
// It lives INSIDE package supervisor because watching that transition means shortening
// the poll interval, which is unexported and never written in production (the same
// reasoning as Supervisor.waitHealthy in rollback_integration_test.go).
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration ./internal/supervisor/
package supervisor

import (
	"context"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

func TestTheAdvertisementFollowsSetupBeingFinished(t *testing.T) {
	s, _ := integrationSupervisor(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	// Seconds, not the production minute: this is the interval, not the behaviour.
	restore := bonjourSetupPoll
	bonjourSetupPoll = time.Second
	t.Cleanup(func() { bonjourSetupPoll = restore })

	t.Cleanup(func() {
		stopCtx, c := context.WithTimeout(context.Background(), 3*time.Minute)
		defer c()
		_ = s.Stop(stopCtx)
	})

	if err := s.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	if bonjour.Tool() == "" {
		t.Skip("no dns-sd client on this platform")
	}

	// ── an empty install asks for help ──────────────────────────────────────────
	before, ok := readBonjourState(s.plan.Layout.BonjourState)
	if !ok {
		t.Fatal("nothing was recorded about the advertisement")
	}
	if !before.Setup {
		t.Errorf("setup = false on an install with no household: %+v", before)
	}
	firstPID := bonjourChildPID(s)
	if firstPID == 0 {
		t.Fatal("the dns-sd child is not running")
	}

	// ── the wizard creates a household ──────────────────────────────────────────
	db := s.plan.Env.PostgresDB()
	if _, err := s.QueryScalar(ctx, db,
		`insert into households (name, timezone) values ('The Seinfelds', 'America/Chicago')`); err != nil {
		t.Fatalf("create a household: %v", err)
	}

	// ── and the network hears about it, with no restart ─────────────────────────
	deadline := time.Now().Add(30 * time.Second)
	var after bonjourState
	for time.Now().Before(deadline) {
		if st, ok := readBonjourState(s.plan.Layout.BonjourState); ok && !st.Setup {
			after = st
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if after.Name == "" {
		t.Fatalf("the advertisement never picked up the new household (still %+v)", before)
	}
	if after.Name != "The Seinfelds" {
		t.Errorf("advertised name = %q, want the household's own name", after.Name)
	}
	if after.Setup {
		t.Error("setup is still 1 — a phone would keep offering to finish a setup that is done")
	}
	if pid := bonjourChildPID(s); pid == 0 || pid == firstPID {
		t.Errorf("the dns-sd child was not replaced (pid %d, was %d) — mDNSResponder would "+
			"still be publishing the old name", pid, firstPID)
	}
	if b := s.BonjourStatus(); !b.Advertised || b.Name != "The Seinfelds" {
		t.Errorf("status does not report the new advertisement: %+v", b)
	}
}

// bonjourChildPID is the pid of the live advertiser, or 0 when there is none.
func bonjourChildPID(s *Supervisor) int {
	s.mu.Lock()
	c := s.children[services.Bonjour]
	s.mu.Unlock()
	if c == nil || !c.running() {
		return 0
	}
	return c.currentPid()
}
