package rtstate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingFileYieldsAZeroState(t *testing.T) {
	s, existed, err := Load(filepath.Join(t.TempDir(), "runtime.json"))
	if err != nil {
		t.Fatalf("a missing runtime.json is a first run, not an error: %v", err)
	}
	if existed {
		t.Error("existed must be false for a missing file")
	}
	if s.Ports.Public != 0 {
		t.Errorf("expected an unset state, got %+v", s.Ports)
	}
}

func TestRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	want := &State{
		Schema:     Schema,
		InstallID:  "abc-123",
		CreatedAt:  "2026-09-08T00:00:00Z",
		Ports:      Ports{Public: 8082, PowerSyncPublic: 8083, API: 3002, PowerSync: 8084, Postgres: 5434},
		SocketDir:  "/tmp/wfl123",
		BundleSHA:  "deadbeef",
		BundleTime: "2026-09-04T23:48:42.438Z",
	}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, existed, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !existed {
		t.Error("existed must be true after Save")
	}
	if *got != *want {
		t.Fatalf("round trip changed the state:\n got %+v\nwant %+v", *got, *want)
	}
}

func TestSaveWritesReadableIndentedJSONWithStableKeys(t *testing.T) {
	// runtime.json is the contract the menu-bar app and support requests read; it must
	// be a human-openable file, not a minified blob.
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := Save(path, &State{Schema: Schema, Ports: Ports{Public: 8080}}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatalf("runtime.json is not valid JSON: %v", err)
	}
	if _, ok := generic["ports"]; !ok {
		t.Errorf(`expected a "ports" object, got keys %v`, keys(generic))
	}
	if _, ok := generic["schema"]; !ok {
		t.Errorf(`expected a "schema" field, got keys %v`, keys(generic))
	}
	if raw[len(raw)-1] != '\n' {
		t.Error("runtime.json should end with a newline")
	}
}

func TestLoadRejectsAFutureSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	if err := os.WriteFile(path, []byte(`{"schema": 99, "ports": {}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Fatal("a runtime.json written by a newer binary must be refused, not silently reused")
	}
}

func TestNewStateHasAnInstallIDAndSchema(t *testing.T) {
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if s.Schema != Schema {
		t.Errorf("schema = %d, want %d", s.Schema, Schema)
	}
	if len(s.InstallID) < 16 {
		t.Errorf("install id looks too short: %q", s.InstallID)
	}
	if s.CreatedAt == "" {
		t.Error("createdAt should be stamped")
	}
	other, _ := New()
	if other.InstallID == s.InstallID {
		t.Error("install ids must be unique per install")
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
