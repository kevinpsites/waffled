// Package relocate moves a household's data directory to another folder on this Mac.
//
// It is copy-then-remove rather than a rename: a rename cannot cross volumes, and moving
// Waffled off a full startup disk is the reason anyone asks. The original is removed only
// after the copy has arrived whole, so a failure anywhere leaves the household exactly
// where it was.
//
// The Caddyfile needs no attention — the supervisor writes it on every start. runtime.json
// does: it remembers the Postgres socket directory and `datadir.SocketDir` trusts that
// value outright, so a path into the folder we are about to delete has to be forgotten.
package relocate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

var (
	// ErrServerRunning is the refusal that matters: copying a live Postgres cluster
	// copies it mid-write, and what arrives is a database that looks fine until it does
	// not.
	ErrServerRunning = errors.New("Waffled is running")
	// ErrRefused is a destination this cannot be asked to use.
	ErrRefused = errors.New("that folder cannot hold Waffled")
	// ErrNoRoom is the destination volume being too small, checked before a byte moves.
	ErrNoRoom = errors.New("there is not enough room")
)

// headroom is kept free at the destination on top of the household's own size, so a move
// that just fits does not leave a volume with nothing left for the first backup.
const headroom = 512 << 20

// Options is one move.
type Options struct {
	// Layout is where the data directory is now.
	Layout datadir.Layout
	// To is the folder it should end up as — the new root itself, not its parent.
	To string

	// Alive, Avail and Copy are the seams: no test signals a process, asks a real
	// volume how big it is, or copies a real Postgres cluster.
	Alive func(pid int) bool
	Avail func(path string) (uint64, error)
	Copy  func(ctx context.Context, src, dst string) error
}

// Plan is what a move will do, or what it did — the same shape either way, because a
// caller printing it should not have to ask which.
type Plan struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Bytes int64  `json:"bytes"`
	// ForgotSocketDir reports that runtime.json's socket directory pointed into the old
	// folder and was cleared, so the next start re-derives it from the new one.
	ForgotSocketDir bool `json:"forgotSocketDir"`
}

func (o *Options) fill() {
	if o.Alive == nil {
		o.Alive = processAlive
	}
	if o.Avail == nil {
		o.Avail = datadir.FreeBytes
	}
	if o.Copy == nil {
		o.Copy = copyTree
	}
}

// Inspect validates the move and measures it without touching anything.
func Inspect(o Options) (Plan, error) {
	o.fill()
	from := filepath.Clean(o.Layout.Root)
	to, err := filepath.Abs(filepath.Clean(o.To))
	if err != nil {
		return Plan{}, fmt.Errorf("%w: %s cannot be resolved", ErrRefused, o.To)
	}

	if pid, running := supervisorPid(o); running {
		return Plan{}, fmt.Errorf("%w (supervisor pid %d) — stop it first with "+
			"`waffled-runtime stop`", ErrServerRunning, pid)
	}
	if err := checkDestination(from, to); err != nil {
		return Plan{}, err
	}

	size := dirSize(from)
	// The volume is asked about the nearest parent that exists: the destination itself
	// usually does not yet, and statfs on a path that is not there answers nothing.
	if avail, err := o.Avail(nearestExisting(to)); err == nil {
		if need := uint64(size) + headroom; avail < need {
			return Plan{}, fmt.Errorf("%w on %s: Waffled needs %s and there is %s free",
				ErrNoRoom, to, datadir.HumanBytes(int64(need)), datadir.HumanBytes(int64(avail)))
		}
	}
	return Plan{From: from, To: to, Bytes: size, ForgotSocketDir: socketDirIsInside(o.Layout, from)}, nil
}

// Run does the move: copy, forget a stale socket directory, then remove the original.
//
// The order is the safety. Nothing is deleted until the copy has arrived, and a copy that
// fails takes its own half-written destination with it rather than leaving one to be
// found later and mistaken for a household.
func Run(ctx context.Context, o Options) (Plan, error) {
	o.fill()
	plan, err := Inspect(o)
	if err != nil {
		return Plan{}, err
	}

	// An empty directory the person made in Finder before choosing it is the ordinary
	// case, so it is not this function's to remove on failure — only a destination we
	// created ourselves is.
	madeIt := false
	if _, statErr := os.Stat(plan.To); os.IsNotExist(statErr) {
		madeIt = true
	}
	if err := os.MkdirAll(plan.To, 0o700); err != nil {
		return Plan{}, fmt.Errorf("create %s: %w", plan.To, err)
	}
	if err := o.Copy(ctx, plan.From, plan.To); err != nil {
		if madeIt {
			os.RemoveAll(plan.To)
		}
		return Plan{}, fmt.Errorf("copy %s to %s: %w", plan.From, plan.To, err)
	}
	// The copy carried whatever mode the old root had; the new one is a fresh folder on
	// a volume whose umask we do not know, and it holds every secret this household has.
	if err := os.Chmod(plan.To, 0o700); err != nil {
		return Plan{}, fmt.Errorf("secure %s: %w", plan.To, err)
	}
	if plan.ForgotSocketDir {
		if err := forgetSocketDir(plan.To); err != nil {
			return Plan{}, err
		}
	}
	if err := os.RemoveAll(plan.From); err != nil {
		// The household is at the new address and whole; the old copy failing to go is
		// worth saying, and is not worth undoing a good move over.
		return plan, fmt.Errorf("Waffled moved to %s, but %s could not be removed: %w",
			plan.To, plan.From, err)
	}
	return plan, nil
}

// checkDestination is every reason a folder cannot be the new one.
func checkDestination(from, to string) error {
	if to == from {
		return fmt.Errorf("%w: Waffled is already there", ErrRefused)
	}
	// A destination under the source would be copied into itself, and then deleted along
	// with the source it was nested in.
	if strings.HasPrefix(to+string(filepath.Separator), from+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s is inside the folder being moved", ErrRefused, to)
	}
	entries, err := os.ReadDir(to)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("%w: %s cannot be read: %v", ErrRefused, to, err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("%w: %s already has something in it — Waffled needs a folder "+
			"of its own", ErrRefused, to)
	}
	return nil
}

// socketDirIsInside reports whether runtime.json's remembered socket directory lives in
// the folder about to be deleted. The other kind — a short `wfl*` temp directory made
// because the data path was too long for a unix socket — is still valid afterwards.
func socketDirIsInside(l datadir.Layout, root string) bool {
	s, _, err := rtstate.Load(l.RuntimeJSON)
	if err != nil || s == nil || s.SocketDir == "" {
		return false
	}
	dir := filepath.Clean(s.SocketDir)
	return dir == root || strings.HasPrefix(dir+string(filepath.Separator), root+string(filepath.Separator))
}

func forgetSocketDir(root string) error {
	path := datadir.At(root).RuntimeJSON
	s, found, err := rtstate.Load(path)
	if err != nil || !found {
		return err
	}
	s.SocketDir = ""
	return rtstate.Save(path, s)
}

func supervisorPid(o Options) (int, bool) {
	raw, err := os.ReadFile(o.Layout.PidPath(supervisor.SupervisorPidName))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, o.Alive(pid)
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// nearestExisting walks up until it finds a directory that is really there, so a
// destination that has not been created yet can still be asked which volume it is on.
func nearestExisting(path string) string {
	for {
		if _, err := os.Stat(path); err == nil {
			return path
		}
		parent := filepath.Dir(path)
		if parent == path {
			return path
		}
		path = parent
	}
}

func dirSize(root string) int64 {
	var total int64
	filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// copyGeneric is the portable copy: entries in order, modes preserved, symlinks recreated
// rather than followed. `ditto` is used instead on macOS (see copy_darwin.go), because a
// Postgres cluster carries xattrs — the Time Machine exclusion among them — that a
// hand-written walk would quietly drop.
func copyGeneric(ctx context.Context, src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, info.Mode().Perm())
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case !info.Mode().IsRegular():
			// Sockets and fifos belong to a process that is not running; a stopped
			// cluster does not need them and cannot use a copy of one.
			return nil
		default:
			return copyFile(path, target, info.Mode().Perm())
		}
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
