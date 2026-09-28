package relocate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

// household builds a data directory with something recognisable in every corner, so a
// move that drops a file is a failing assertion rather than a passing one.
func household(t *testing.T) datadir.Layout {
	t.Helper()
	l := datadir.At(filepath.Join(t.TempDir(), "Application Support", "Waffled"))
	if err := l.Ensure(); err != nil {
		t.Fatal(err)
	}
	write(t, l.ConfigEnv, "LOCAL_JWT_SECRET=not-a-real-secret\n")
	write(t, filepath.Join(l.Postgres, "PG_VERSION"), "16\n")
	write(t, filepath.Join(l.Media, "photo.jpg"), "jpeg-bytes")
	write(t, filepath.Join(l.Backups, "nightly.dump"), "dump-bytes")
	write(t, filepath.Join(l.Logs, "runtime.log"), "started\n")
	saveState(t, l, &rtstate.State{Schema: rtstate.Schema, InstallID: "abc"})
	return l
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func saveState(t *testing.T, l datadir.Layout, s *rtstate.State) {
	t.Helper()
	if err := rtstate.Save(l.RuntimeJSON, s); err != nil {
		t.Fatal(err)
	}
}

func loadState(t *testing.T, root string) rtstate.State {
	t.Helper()
	raw, err := os.ReadFile(datadir.At(root).RuntimeJSON)
	if err != nil {
		t.Fatal(err)
	}
	var s rtstate.State
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// options wires the seams so no test touches a real process or a real volume.
func options(l datadir.Layout, to string) Options {
	return Options{
		Layout: l,
		To:     to,
		Alive:  func(int) bool { return false },
		Avail:  func(string) (uint64, error) { return 1 << 40, nil },
	}
}

func TestRefusesWhileTheServerIsRunning(t *testing.T) {
	l := household(t)
	write(t, l.PidPath(supervisor.SupervisorPidName), strconv.Itoa(4242)+"\n")
	o := options(l, filepath.Join(t.TempDir(), "Waffled"))
	o.Alive = func(pid int) bool { return pid == 4242 }

	_, err := Run(context.Background(), o)
	if !errors.Is(err, ErrServerRunning) {
		t.Fatalf("moving a live cluster must refuse, got %v", err)
	}
	// Nothing may have been created at the destination by a refusal.
	if _, statErr := os.Stat(o.To); statErr == nil {
		t.Errorf("%s was created by a refused move", o.To)
	}
}

func TestRefusesADestinationInsideTheFolderItIsMoving(t *testing.T) {
	l := household(t)
	o := options(l, filepath.Join(l.Root, "somewhere", "else"))

	if _, err := Run(context.Background(), o); !errors.Is(err, ErrRefused) {
		t.Fatalf("a destination under the source must refuse, got %v", err)
	}
}

func TestRefusesADestinationThatAlreadyHasSomethingInIt(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")
	write(t, filepath.Join(to, "someone-elses.txt"), "hello")

	if _, err := Run(context.Background(), options(l, to)); !errors.Is(err, ErrRefused) {
		t.Fatalf("a non-empty destination must refuse, got %v", err)
	}
	// And it must still be there.
	if _, err := os.Stat(filepath.Join(to, "someone-elses.txt")); err != nil {
		t.Errorf("a refused move deleted somebody else's file: %v", err)
	}
}

// An empty directory the person made in Finder before choosing it is the ordinary case,
// not a refusal.
func TestAcceptsADestinationThatExistsButIsEmpty(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(to, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(context.Background(), options(l, to)); err != nil {
		t.Fatalf("an empty destination should be usable: %v", err)
	}
}

func TestRefusesWhenTheDestinationHasNoRoomForIt(t *testing.T) {
	l := household(t)
	o := options(l, filepath.Join(t.TempDir(), "Waffled"))
	o.Avail = func(string) (uint64, error) { return 1, nil }

	if _, err := Run(context.Background(), o); !errors.Is(err, ErrNoRoom) {
		t.Fatalf("a destination with no room must refuse before copying, got %v", err)
	}
	if _, err := os.Stat(l.ConfigEnv); err != nil {
		t.Errorf("a refused move damaged the original: %v", err)
	}
}

func TestMovesEveryFileAndTakesTheOldFolderAway(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	plan, err := Run(context.Background(), options(l, to))
	if err != nil {
		t.Fatal(err)
	}
	if plan.To != to || plan.From != l.Root {
		t.Errorf("plan = %+v, want a move from %q to %q", plan, l.Root, to)
	}
	for rel, want := range map[string]string{
		"config.env":           "LOCAL_JWT_SECRET=not-a-real-secret\n",
		"postgres/PG_VERSION":  "16\n",
		"media/photo.jpg":      "jpeg-bytes",
		"backups/nightly.dump": "dump-bytes",
		"logs/runtime.log":     "started\n",
	} {
		got, err := os.ReadFile(filepath.Join(to, rel))
		if err != nil {
			t.Errorf("%s did not arrive: %v", rel, err)
			continue
		}
		if string(got) != want {
			t.Errorf("%s = %q, want %q", rel, got, want)
		}
	}
	if _, err := os.Stat(l.Root); !os.IsNotExist(err) {
		t.Errorf("the old folder is still there: %v", err)
	}
}

// The data directory holds secrets, so the copy must not widen what could read them.
func TestTheNewFolderIsOwnerOnly(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")
	if _, err := Run(context.Background(), options(l, to)); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(to)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("moved data dir is %o, want owner-only", perm)
	}
}

// runtime.json remembers the socket directory and `SocketDir(recorded)` trusts it
// outright, so a path into the folder we just deleted would have Postgres put its socket
// back at the old address — where it starts, logs nothing, and answers nobody.
func TestForgetsASocketDirectoryThatPointedIntoTheOldFolder(t *testing.T) {
	l := household(t)
	saveState(t, l, &rtstate.State{Schema: rtstate.Schema, SocketDir: l.Postgres})
	to := filepath.Join(t.TempDir(), "Waffled")

	plan, err := Run(context.Background(), options(l, to))
	if err != nil {
		t.Fatal(err)
	}
	if !plan.ForgotSocketDir {
		t.Error("the plan should say the socket directory was forgotten")
	}
	if got := loadState(t, to).SocketDir; got != "" {
		t.Errorf("socketDir = %q, want it cleared so it re-derives from the new folder", got)
	}
}

// The other kind is a short temp directory outside the data root, made because the data
// path was too long for a unix socket. It is still valid after the move.
func TestKeepsAShortSocketDirectoryThatLivesOutsideTheFolder(t *testing.T) {
	l := household(t)
	short := t.TempDir()
	saveState(t, l, &rtstate.State{Schema: rtstate.Schema, SocketDir: short})
	to := filepath.Join(t.TempDir(), "Waffled")

	plan, err := Run(context.Background(), options(l, to))
	if err != nil {
		t.Fatal(err)
	}
	if plan.ForgotSocketDir {
		t.Error("a socket directory outside the data folder is still good")
	}
	if got := loadState(t, to).SocketDir; got != short {
		t.Errorf("socketDir = %q, want %q", got, short)
	}
}

func TestInspectChangesNothing(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	plan, err := Inspect(options(l, to))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Bytes <= 0 {
		t.Errorf("plan should say how much there is to move, got %d", plan.Bytes)
	}
	if _, err := os.Stat(to); !os.IsNotExist(err) {
		t.Errorf("Inspect created %s", to)
	}
	if _, err := os.Stat(l.ConfigEnv); err != nil {
		t.Errorf("Inspect disturbed the original: %v", err)
	}
}

// The one that matters: a copy that dies halfway must leave the household exactly where
// it was, with nothing half-written left at the destination to be found later.
func TestACopyThatFailsLeavesTheOriginalWhereItWas(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")
	o := options(l, to)
	o.Copy = func(_ context.Context, _, dst string) error {
		write(t, filepath.Join(dst, "half-written"), "oops")
		return errors.New("the disk gave up")
	}

	if _, err := Run(context.Background(), o); err == nil {
		t.Fatal("a failed copy must be reported")
	}
	if got, err := os.ReadFile(l.ConfigEnv); err != nil || string(got) == "" {
		t.Errorf("the original config.env should be untouched, got %q %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(l.Postgres, "PG_VERSION")); err != nil {
		t.Errorf("the original cluster should be untouched: %v", err)
	}
	if _, err := os.Stat(to); !os.IsNotExist(err) {
		t.Errorf("a failed copy left %s behind", to)
	}
}

// A destination the person picked that turns out to be the folder it is already in is a
// no-op worth saying out loud rather than a delete-then-copy of the whole household.
func TestRefusesToMoveAFolderOntoItself(t *testing.T) {
	l := household(t)
	if _, err := Run(context.Background(), options(l, l.Root)); !errors.Is(err, ErrRefused) {
		t.Fatalf("moving onto itself must refuse, got %v", err)
	}
	if _, err := os.Stat(l.ConfigEnv); err != nil {
		t.Errorf("the household is gone: %v", err)
	}
}
