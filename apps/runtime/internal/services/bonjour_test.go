package services

import (
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
)

func bonjourInstance() bonjour.Instance {
	return bonjour.Instance{
		Name: "The Seinfelds", Port: 8080,
		URL: "http://192.168.1.5:8080", Version: "0.14.3",
	}
}

func TestBonjourSpecRegistersThroughTheSystemClient(t *testing.T) {
	spec := testPlan(t).Bonjour(bonjourInstance())

	if spec.Name != Bonjour {
		t.Errorf("name = %q, want %q", spec.Name, Bonjour)
	}
	if spec.OneShot {
		t.Error("the advertiser is long-running: dns-sd withdraws the registration when it exits")
	}
	if spec.HealthURL != "" {
		t.Errorf("health URL = %q, want none — there is nothing to poll", spec.HealthURL)
	}
	// dns-sd binds nothing. Carrying the public port here would invite a reader to add
	// the advertiser to a port table it has no business being in.
	if spec.Port != 0 {
		t.Errorf("port = %d, want 0", spec.Port)
	}
	if len(spec.Env) == 0 {
		t.Error("env is empty — children never inherit the operator's environment")
	}
	if bonjour.Tool() == "" {
		if spec.Path != "" || spec.Args != nil {
			t.Errorf("without a dns-sd client the spec must be empty, got %q %q", spec.Path, spec.Args)
		}
		return
	}
	if spec.Path != bonjour.Tool() {
		t.Errorf("path = %q, want %q", spec.Path, bonjour.Tool())
	}
	if got := strings.Join(spec.Args, " "); !strings.Contains(got, "-R The Seinfelds "+bonjour.ServiceType+" . 8080") {
		t.Errorf("args = %q, want a registration of the public port", spec.Args)
	}
}

// The advertiser is advisory: it is not part of the server, and a household whose
// Bonjour registration failed still has a working Waffled. Keeping it out of Children()
// is what keeps it out of `status`'s services array (which the menu-bar app renders as
// rows) and out of DeriveState.
func TestBonjourIsNotOneOfTheServerServices(t *testing.T) {
	p := testPlan(t)
	for _, spec := range p.Children() {
		if spec.Name == Bonjour {
			t.Fatal("bonjour is in Children() — a failed advertisement would then make the whole stack unhealthy")
		}
	}
	for _, c := range p.PortChecks() {
		if c.Service == Bonjour {
			t.Fatal("bonjour is in PortChecks() — dns-sd listens on nothing")
		}
	}
	for _, name := range Order {
		if name == Bonjour {
			t.Fatal("bonjour is in Order — it is not a step of the start sequence")
		}
	}
}
