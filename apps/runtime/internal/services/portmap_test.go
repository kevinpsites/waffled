package services

import (
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
)

// The port table used to be hand-copied into settlePorts and Doctor, and serviceStatus
// switched on the service name to find a port the Spec could simply carry. One
// descriptor list now feeds all three, so a sixth service or a second Caddy site is one
// edit rather than five.
func TestPortChecksCoverEveryPortTheStackBinds(t *testing.T) {
	p := testPlan(t)
	checks := p.PortChecks()

	want := map[int]struct {
		service string
		scope   ports.Scope
	}{
		p.Ports.Public:          {Caddy, ports.Public},
		p.Ports.PowerSyncPublic: {Caddy, ports.Public},
		p.Ports.API:             {API, ports.Loopback},
		p.Ports.PowerSync:       {PowerSync, ports.Loopback},
		p.Ports.Postgres:        {Postgres, ports.Loopback},
	}
	if len(checks) != len(want) {
		t.Fatalf("got %d checks, want %d: %+v", len(checks), len(want), checks)
	}

	seenLabels := map[string]bool{}
	for _, c := range checks {
		w, ok := want[c.Port]
		if !ok {
			t.Errorf("unexpected port %d in the table", c.Port)
			continue
		}
		if c.Service != w.service {
			t.Errorf("port %d is attributed to %q, want %q", c.Port, c.Service, w.service)
		}
		if c.Scope != w.scope {
			t.Errorf("port %d has the wrong scope — probing the wrong address gives the wrong answer", c.Port)
		}
		if c.Label == "" {
			t.Errorf("port %d has no label for doctor to print", c.Port)
		}
		if seenLabels[c.Label] {
			t.Errorf("two ports share the label %q; doctor would print the same row twice", c.Label)
		}
		seenLabels[c.Label] = true
		delete(want, c.Port)
	}
	if len(want) > 0 {
		t.Errorf("ports missing from the table: %v", want)
	}
}

// Only Caddy is reachable from the LAN. The api, PowerSync and Postgres bind loopback —
// natively there is no container network to hide behind.
func TestOnlyCaddysPortsArePublic(t *testing.T) {
	p := testPlan(t)
	for _, c := range p.PortChecks() {
		if c.Scope == ports.Public && c.Service != Caddy {
			t.Errorf("%s (%s) is on the public scope; only Caddy may be", c.Service, c.Label)
		}
		if c.Scope == ports.Loopback && c.Service == Caddy {
			t.Errorf("Caddy's %s port is loopback-only; nothing on the LAN could reach it", c.Label)
		}
	}
}

// Children is the supervised set — the list Start walks forwards and Stop backwards.
// Postgres is deliberately absent: pg_ctl exits once the postmaster is up, so watching
// it as a child would read a successful start as a crash and restart-loop forever.
func TestChildrenAreTheSupervisedServicesInDependencyOrder(t *testing.T) {
	p := testPlan(t)
	children := p.Children()

	want := []string{API, PowerSync, Caddy}
	if len(children) != len(want) {
		t.Fatalf("got %d children, want %d", len(children), len(want))
	}
	for i, spec := range children {
		if spec.Name != want[i] {
			t.Errorf("child %d is %q, want %q", i, spec.Name, want[i])
		}
		if spec.Name == Postgres {
			t.Error("postgres must never be supervised as a child")
		}
		if spec.OneShot {
			t.Errorf("%s is a long-running service, not a one-shot", spec.Name)
		}
	}
}

// A Spec carries the port it binds, so status does not have to switch on the name to
// find one — that switch is how a new service ends up reported as Port 0 in
// `status --json` for the menu-bar app.
func TestEveryChildSpecCarriesItsPort(t *testing.T) {
	p := testPlan(t)
	want := map[string]int{
		API:       p.Ports.API,
		PowerSync: p.Ports.PowerSync,
		Caddy:     p.Ports.Public,
	}
	for _, spec := range p.Children() {
		if spec.Port != want[spec.Name] {
			t.Errorf("%s carries port %d, want %d", spec.Name, spec.Port, want[spec.Name])
		}
	}
}
