package supervisor

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// A Supervisor that can answer `status` and nothing else: no bundle, no children, an
// empty data directory. `Status` builds every child spec, and the api's spec needs the
// secrets to compose its DATABASE_URL, so the config.env is real.
func reportingSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	layout := datadir.At(t.TempDir())
	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.EnsureSecrets(); err != nil {
		t.Fatal(err)
	}
	log := NewLogger(io.Discard, true)
	return &Supervisor{
		log:    log,
		plan:   services.Plan{Layout: layout, Env: env},
		runner: &runner{logsDir: layout.Logs, pidsDir: layout.Pids, log: log},
	}
}

// The menu-bar app asks "is this a first run?" and is not allowed to answer it itself:
// the runtime owns its layout, so an app that stat'd PGDATA would be the second place
// that knows where the cluster lives. It reads `initialized` off the same cheap poll it
// already makes, which means the report has to carry it whether the stack is up or not.
func TestStatusReportsWhetherTheDataDirectoryIsInitialized(t *testing.T) {
	s := reportingSupervisor(t)

	if s.Status(context.Background()).Initialized {
		t.Error("an empty data directory reported initialized — the app would skip the first-run window")
	}

	pgdata := s.plan.Layout.Postgres
	if err := os.MkdirAll(pgdata, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pgdata, "PG_VERSION"), []byte("16\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if !s.Status(context.Background()).Initialized {
		t.Error("a data directory holding a cluster reported uninitialized — the app would " +
			"show the welcome window on every launch")
	}
}
