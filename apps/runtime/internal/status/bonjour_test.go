package status

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBonjourBlockIsAdditiveAndComplete(t *testing.T) {
	r := sample()
	r.Bonjour = Bonjour{
		Advertised: true, Name: "The Seinfelds", Service: "_waffled._tcp",
		Port: 8082, Host: "kevins-mac-mini.local",
	}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	block, ok := generic["bonjour"].(map[string]any)
	if !ok {
		t.Fatalf("status --json has no bonjour block: %s", raw)
	}
	for _, key := range []string{"advertised", "name", "service", "port", "host", "error"} {
		if _, ok := block[key]; !ok {
			t.Errorf("the bonjour block lost the %q field", key)
		}
	}
	// The block is additive: nothing existing changed meaning, so the schema stays put.
	if Schema != 1 {
		t.Errorf("Schema = %d — adding a block must not bump it", Schema)
	}
}

// A failed advertisement is not a failed server. Bonjour is nowhere in DeriveState, and
// this is the test that says so.
func TestBonjourNeverAffectsTheOverallState(t *testing.T) {
	r := sample()
	r.Bonjour = Bonjour{Advertised: false, Service: "_waffled._tcp", Error: "dns-sd exited with status 1"}
	r.State = ""
	r.Stamp()
	if r.State != StateRunning {
		t.Errorf("state = %q, want running — a Bonjour failure must not make a healthy stack look broken", r.State)
	}
}

func TestTextMentionsTheAdvertisement(t *testing.T) {
	r := sample()
	r.Bonjour = Bonjour{Advertised: true, Name: "The Seinfelds", Service: "_waffled._tcp", Port: 8082, Host: "mini.local"}
	out := r.Text()
	if !strings.Contains(out, "The Seinfelds") || !strings.Contains(out, "_waffled._tcp") {
		t.Errorf("the text output does not show the advertisement:\n%s", out)
	}

	r.Bonjour = Bonjour{Advertised: false, Service: "_waffled._tcp", Error: "dns-sd exited with status 1"}
	out = r.Text()
	if !strings.Contains(out, "dns-sd exited with status 1") {
		t.Errorf("the text output hides why nothing is advertised:\n%s", out)
	}

	// Nothing to say when it is neither advertising nor failing (a stopped stack).
	r.Bonjour = Bonjour{Service: "_waffled._tcp"}
	if out = r.Text(); strings.Contains(out, "_waffled._tcp") {
		t.Errorf("a stopped stack should not talk about Bonjour:\n%s", out)
	}
}
