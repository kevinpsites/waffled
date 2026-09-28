package status

import (
	"encoding/json"
	"strings"
	"testing"
)

func sample() *Report {
	return &Report{
		Schema:    Schema,
		State:     StateRunning,
		DataDir:   "/Users/kev/Library/Application Support/Waffled",
		BundleDir: "/Applications/Waffled.app/Contents/Resources/runtime",
		Ports:     Ports{Public: 8082, PowerSyncPublic: 8083, API: 3002, PowerSync: 8084, Postgres: 5434},
		Services: []Service{
			{Name: "postgres", State: StateRunning, PID: 101, Port: 5434, Health: "ok"},
			{Name: "api", State: StateRunning, PID: 102, Port: 3002, Health: "ok"},
			{Name: "powersync", State: StateRunning, PID: 103, Port: 8084, Health: "ok"},
			{Name: "caddy", State: StateRunning, PID: 104, Port: 8082, Health: "ok"},
		},
	}
}

// status --json is the contract the menu-bar app reads. The field names are API.
func TestJSONShapeIsStable(t *testing.T) {
	raw, err := json.Marshal(sample())
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"schema", "state", "dataDir", "bundleDir", "ports", "services",
		"versions", "bundle", "supervisor", "urls", "generatedAt", "initialized",
	} {
		if _, ok := generic[key]; !ok {
			t.Errorf("status --json lost the %q field — that is a breaking change for the menu-bar app", key)
		}
	}
	// The version-crossing trail. Additive — Schema stays at 1 — and whatever renders it
	// builds its wording from these, so the names are as much of the contract as the rest.
	bundle := generic["bundle"].(map[string]any)
	for _, key := range []string{"version", "previousVersion", "versionChangedAt"} {
		if _, ok := bundle[key]; !ok {
			t.Errorf("status --json's bundle block lost the %q field", key)
		}
	}
	// Direction-neutral, deliberately: a key called "updatedAt" invites a reader to
	// assume the crossing was an update, which is exactly the assumption the text
	// rendering used to make and got wrong on the documented rollback path.
	if _, ok := bundle["updatedAt"]; ok {
		t.Error(`the bundle block calls its timestamp "updatedAt" again — a crossing has no direction of its own`)
	}

	svc := generic["services"].([]any)[0].(map[string]any)
	for _, key := range []string{"name", "state", "pid", "port", "health", "restarts", "lastError", "log"} {
		if _, ok := svc[key]; !ok {
			t.Errorf("a service entry lost the %q field", key)
		}
	}
}

func TestServiceStatesAreTheDocumentedFour(t *testing.T) {
	for _, s := range []string{StateStopped, StateStarting, StateRunning, StateUnhealthy} {
		if s == "" {
			t.Fatal("a state constant is empty")
		}
	}
	if StateStopped != "stopped" || StateStarting != "starting" || StateRunning != "running" || StateUnhealthy != "unhealthy" {
		t.Errorf("state names changed: %q %q %q %q", StateStopped, StateStarting, StateRunning, StateUnhealthy)
	}
}

func TestOverallStateIsDerivedFromTheServices(t *testing.T) {
	cases := []struct {
		name   string
		states []string
		want   string
	}{
		{"all running", []string{StateRunning, StateRunning, StateRunning, StateRunning}, StateRunning},
		{"nothing up", []string{StateStopped, StateStopped, StateStopped, StateStopped}, StateStopped},
		{"still coming up", []string{StateRunning, StateStarting, StateStopped, StateStopped}, StateStarting},
		{"one sick", []string{StateRunning, StateUnhealthy, StateRunning, StateRunning}, StateUnhealthy},
		// A service that died while the rest run is not "starting" — it is a fault.
		{"one died", []string{StateRunning, StateRunning, StateRunning, StateStopped}, StateUnhealthy},
	}
	for _, tc := range cases {
		var svcs []Service
		for i, s := range tc.states {
			svcs = append(svcs, Service{Name: []string{"postgres", "api", "powersync", "caddy"}[i], State: s})
		}
		if got := DeriveState(svcs); got != tc.want {
			t.Errorf("%s: state = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestNoServicesAtAllIsStopped(t *testing.T) {
	if got := DeriveState(nil); got != StateStopped {
		t.Errorf("state = %q, want stopped", got)
	}
}

// The menu shows an address other devices can use; localhost only ever works on the Mac.
func TestURLsCoverLocalAndLAN(t *testing.T) {
	r := sample()
	r.URLs = URLs{Local: "http://127.0.0.1:8082", LAN: "http://192.168.1.5:8082", PowerSync: "http://192.168.1.5:8083"}
	raw, _ := json.Marshal(r)
	if !strings.Contains(string(raw), "192.168.1.5:8082") {
		t.Error("the LAN URL should be in the JSON")
	}
	if !strings.Contains(string(raw), `"local"`) || !strings.Contains(string(raw), `"lan"`) {
		t.Errorf("urls object shape changed: %s", raw)
	}
}

func TestTextRenderingIsHumanReadable(t *testing.T) {
	r := sample()
	r.URLs = URLs{Local: "http://127.0.0.1:8082", LAN: "http://192.168.1.5:8082"}
	r.Versions = Versions{Waffled: "0.14.3", Node: "24.19.0", Postgres: "16.14"}
	out := r.Text()
	for _, want := range []string{"postgres", "api", "powersync", "caddy", "8082", "0.14.3"} {
		if !strings.Contains(out, want) {
			t.Errorf("text status is missing %q:\n%s", want, out)
		}
	}
	// A pid of 0 means "not running" and should read as a dash, not as pid 0.
	r.Services[0].PID = 0
	r.Services[0].State = StateStopped
	if strings.Contains(r.Text(), "pid=0") {
		t.Errorf("a stopped service should not show pid=0:\n%s", r.Text())
	}
}

func TestLastErrorSurfacesOnTheReport(t *testing.T) {
	r := sample()
	r.Services[1].State = StateUnhealthy
	r.Services[1].LastError = "api exited with status 1"
	r.State = DeriveState(r.Services)
	raw, _ := json.Marshal(r)
	if !strings.Contains(string(raw), "api exited with status 1") {
		t.Error("a service's last error must reach the JSON")
	}
	if r.State != StateUnhealthy {
		t.Errorf("state = %q", r.State)
	}
}

// `initialized` is how the menu-bar app knows a first run from every later one. It is a
// top-level bool rather than a service field because it is a fact about the DATA, not
// about anything currently running: an empty data directory reports it false with every
// service stopped, and the app must never stat the runtime's layout to work it out.
func TestInitializedIsATopLevelBool(t *testing.T) {
	r := sample()
	var generic map[string]any
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	if v, ok := generic["initialized"].(bool); !ok || v {
		t.Errorf("initialized = %#v on a report that did not set it, want false", generic["initialized"])
	}

	r.Initialized = true
	raw, _ = json.Marshal(r)
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	if v, _ := generic["initialized"].(bool); !v {
		t.Error("initialized did not survive the round trip")
	}
}
