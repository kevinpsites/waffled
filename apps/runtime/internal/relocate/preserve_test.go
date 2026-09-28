package relocate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
)

// runtime.json is rewritten to forget a stale socket directory, and that rewrite must not
// be a round trip through a Go struct: a household moved by this version could have been
// written by a newer one, whose fields this binary has never heard of. Dropping them is
// exactly what a command whose promise is "nothing is lost" must not do.
func TestAFieldThisVersionDoesNotKnowSurvivesTheMove(t *testing.T) {
	l := household(t)
	saveState(t, l, &rtstate.State{Schema: rtstate.Schema, InstallID: "abc", SocketDir: l.Postgres})

	// Written the way a newer runtime would leave it: our own fields, plus one more.
	var loose map[string]any
	raw, err := os.ReadFile(l.RuntimeJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &loose); err != nil {
		t.Fatal(err)
	}
	loose["somethingNewerWrote"] = "keep me"
	patched, err := json.Marshal(loose)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.RuntimeJSON, patched, 0o644); err != nil {
		t.Fatal(err)
	}

	to := filepath.Join(t.TempDir(), "Waffled")
	if _, err := Run(context.Background(), options(l, to)); err != nil {
		t.Fatal(err)
	}

	var after map[string]any
	moved, err := os.ReadFile(datadir.At(to).RuntimeJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(moved, &after); err != nil {
		t.Fatal(err)
	}

	if after["somethingNewerWrote"] != "keep me" {
		t.Errorf("a field this version does not know was dropped: %v", after)
	}
	if _, still := after["socketDir"]; still {
		t.Errorf("socketDir should be gone, got %v", after["socketDir"])
	}
	if after["installId"] != "abc" {
		t.Errorf("the fields we do know must survive too, got %v", after["installId"])
	}
}
