// Package uninstall removes what the runtime itself put on this machine, and says
// plainly what it left alone.
//
// Two rules shape all of it, from docs/product/native-mac-plan.md §5: nothing dead is
// left behind, and the household's data is never deleted silently. Keeping the data is
// therefore the default and deleting it is an explicit flag, and every run — dry or
// real — prints the full inventory with "kept" against what survives.
//
// It deliberately does NOT go through internal/supervisor. Constructing a Supervisor
// writes to the very directory being inventoried: it creates the whole layout, writes
// config.env (generating secrets), bundle-verified.json and runtime.json, and sets the
// Time Machine xattr. A --dry-run through that path would change the thing it promised
// not to touch, and a second run would find a freshly recreated data directory and
// report everything present again.
package uninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

// Schema is the version of the --json document. Bump it only for a breaking change:
// the Mac app's "Remove Waffled…" parses this.
const Schema = 1

// Item kinds.
const (
	KindSchedule = "schedule"
	KindBonjour  = "bonjour"
	KindPidfiles = "pidfiles"
	KindSocket   = "socket"
	KindData     = "data"
)

// Item actions.
const (
	ActionRemove = "remove"
	ActionKeep   = "keep"
)

// Item is one thing the runtime put on this machine.
type Item struct {
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Action    string `json:"action"`
	Present   bool   `json:"present"`
	Detail    string `json:"detail,omitempty"`
	// Error is why this item could not be removed. Its absence on a present item with
	// action "remove" is what makes "removed" mean removed.
	Error string `json:"error,omitempty"`
}

// Report is the whole inventory, and the shape of --json.
type Report struct {
	Schema        int    `json:"schema"`
	DataDir       string `json:"dataDir"`
	DataSizeBytes int64  `json:"dataSizeBytes"`
	Items         []Item `json:"items"`
	// DryRun says whether this document is a plan or a receipt. Without it the two are
	// shape-identical, and the Mac app parsing this could not tell them apart.
	DryRun bool `json:"dryRun"`

	// foundRunning records that the inventory was taken while a supervisor was up. Only
	// the wording depends on it, so it stays out of the document — the pidfiles item
	// already carries the fact.
	foundRunning bool
}

// ScheduleAgent is the part of *schedule.Agent this command uses.
//
// It is an interface for one reason: Agent.Uninstall boots out a launchd LABEL
// (gui/<uid>/app.waffled.backup), not a path, so pointing a real agent at a temp
// AgentsDir would still unload the nightly backup of whoever runs the test suite.
type ScheduleAgent interface {
	PlistPath() string
	Installed() bool
	// ScheduledDataDir is which data directory the installed plist backs up. An error
	// means unknown, and unknown must never be read as "ours".
	ScheduledDataDir() (string, error)
	Uninstall() error
}

// ErrRefused marks an error raised before anything was attempted. Every other failure is
// partial by nature — some items removed, some not — and leaves a report worth printing;
// a refusal leaves none, and printing the plan for one reads as a receipt for work that
// never happened. Callers test for this, not for the individual refusals below.
var ErrRefused = errors.New("nothing was changed")

// ErrServerRunning is the refusal a caller most needs to tell apart: it is the one the
// user can clear themselves, by stopping the server or passing --yes.
var ErrServerRunning = errors.New("the Waffled server is still running")

// errStillRunning marks the one failure that may block deleting the data root: something
// this run signalled and could not kill. A failed unlink from the same item is a
// filesystem problem, not a live process, and must not be reported as one.
var errStillRunning = errors.New("a process this run could not stop")

// Options describe one uninstall.
type Options struct {
	// Layout is the data directory to inventory. It is never created.
	Layout datadir.Layout
	// Agent is the nightly backup schedule. Nil skips that item entirely.
	Agent ScheduleAgent
	// DeleteData turns the data root from kept into removed.
	DeleteData bool
	DryRun     bool
	// Yes allows the run to stop a server that is still up.
	Yes bool
	// Log receives the narration a person reads (what was stopped, what could not be
	// removed). The inventory itself goes through Report.
	Log io.Writer

	// The process seams. Tests replace them; nothing else may.
	alive  func(pid int) bool
	signal func(pid int, sig syscall.Signal) error
	// grace overrides orphanGrace, so a test need not wait out a real one.
	grace time.Duration
}

// How long a process gets to exit after SIGTERM before it is killed.
//
// The supervisor gets minutes because what it is doing is stopping five services in
// dependency order. An orphan gets seconds, the same as supervisor.stopOrphan: there may
// be one pidfile per service and they are signalled in sequence, so a per-orphan wait in
// minutes would run the whole command out of its own deadline.
const (
	supervisorGrace = 2 * time.Minute
	orphanGrace     = 15 * time.Second
	// killGrace is how long a SIGKILL'd process gets to actually disappear.
	killGrace = 500 * time.Millisecond
)

const pollInterval = 200 * time.Millisecond

func (o *Options) applyDefaults() {
	if o.Log == nil {
		o.Log = io.Discard
	}
	if o.alive == nil {
		o.alive = processAlive
	}
	if o.signal == nil {
		o.signal = signalPid
	}
	if o.grace == 0 {
		o.grace = orphanGrace
	}
}

// Inspect builds the inventory without touching anything. Its report is always a plan:
// nothing here has been done, and a report that read as a receipt would be a lie in
// whatever the caller prints.
func Inspect(o Options) Report {
	o.applyDefaults()
	r := o.inspect()
	r.DryRun = true
	return r
}

// Run carries the plan out, and returns the inventory as it stood before it did.
//
// The report is the state found, not the state left: a first run says present: true /
// action: remove for everything it then removes, and a second run says present: false
// for all of it and exits 0.
func Run(ctx context.Context, o Options) (Report, error) {
	o.applyDefaults()
	report := o.inspect()

	// Checked before the dry run returns, not after: the dry run is the safety preview
	// for this flag, so it must never promise a deletion the real run refuses.
	//
	// --delete-data is one flag away from an rm -rf of whatever --data named, so the
	// directory has to look like ours before it goes. `waffled-runtime uninstall --data ~
	// --delete-data` is a plausible slip and would otherwise take the home folder with it.
	if o.DeleteData && report.item(KindData).Present && !o.looksLikeDataDir() {
		return report, fmt.Errorf(
			"%s has none of Waffled's own files in it (no config.env, runtime.json or postgres/) — "+
				"refusing to delete it. Point --data at the right directory; %w",
			o.Layout.Root, ErrRefused)
	}

	// A dry run reports a running server rather than refusing over it: it changes
	// nothing, and "is it safe to uninstall yet" is exactly what it is for.
	if pid, running := o.supervisorPid(); running && !o.DryRun {
		if !o.Yes {
			return report, o.refusal(pid)
		}
		fmt.Fprintf(o.Log, "Stopping the running server (pid %d)…\n", pid)
		if err := o.terminate(ctx, pid, supervisorGrace); err != nil {
			// Nothing below has run. Without this every item would default to
			// "removed" in the report main goes on to print.
			report.markNotAttempted("the server could not be stopped")
			return report, fmt.Errorf("stop the running server: %w", err)
		}
		fmt.Fprintf(o.Log, "Stopped.\n")
	}
	if o.DryRun {
		return report, nil
	}

	var problems []error
	// Only a failure that could still be holding the data root open blocks deleting it —
	// a launchd plist that would not unload cannot be, and refusing over it would leave
	// someone re-running a command that never gets any further.
	stillLive := false

	// The data root is deliberately NOT part of this loop. It has to go last — nothing
	// that may still be running may be left holding it open — and hanging that on
	// inspect() happening to append it last would be an ordering two hundred lines away
	// that nothing states and no test protects.
	for i := range report.Items {
		it := &report.Items[i]
		if it.Kind == KindData || !it.Present || it.Action != ActionRemove {
			continue
		}
		if err := o.remove(ctx, *it); err != nil {
			it.Error = unwrapMarker(err)
			problems = append(problems, err)
			if errors.Is(err, errStillRunning) {
				stillLive = true
			}
		}
	}

	for i := range report.Items {
		it := &report.Items[i]
		if it.Kind != KindData || !it.Present || it.Action != ActionRemove {
			continue
		}
		if stillLive {
			it.Error = "something that may still be running could not be stopped"
			problems = append(problems, fmt.Errorf("left %s in place — %s", o.Layout.Root, it.Error))
			continue
		}
		if err := o.remove(ctx, *it); err != nil {
			it.Error = err.Error()
			problems = append(problems, err)
		}
	}
	return report, errors.Join(problems...)
}

// refusal explains the running server, and how to get past it.
//
// processAlive counts EPERM as alive deliberately, so this fires for a supervisor owned
// by another account and for a recycled pid that now belongs to somebody else's process.
// In that case both of the ordinary remedies dead-end on the same EPERM — `stop` cannot
// signal it either — and the only way out is the pidfile, so the message says so rather
// than sending someone round the loop twice.
func (o Options) refusal(pid int) error {
	if err := o.signal(pid, syscall.Signal(0)); errors.Is(err, syscall.EPERM) {
		return fmt.Errorf(
			"%w (supervisor pid %d), and it belongs to another user — neither "+
				"`waffled-runtime stop` nor --yes can signal it. Stop it from that account, or "+
				"if that pid is not Waffled at all, delete %s and run this again; %w",
			ErrServerRunning, pid, o.Layout.PidPath(supervisor.SupervisorPidName), ErrRefused)
	}
	return fmt.Errorf(
		"%w (supervisor pid %d) — stop it first with `waffled-runtime stop`, "+
			"or pass --yes to stop it as part of the uninstall; %w",
		ErrServerRunning, pid, ErrRefused)
}

// markNotAttempted records that the run ended before the removals began, so nothing in
// the report reads back as done.
func (r *Report) markNotAttempted(why string) {
	for i := range r.Items {
		if r.Items[i].Present && r.Items[i].Action == ActionRemove {
			r.Items[i].Error = "not attempted — " + why
		}
	}
}

func (o Options) remove(ctx context.Context, it Item) error {
	switch it.Kind {
	case KindSchedule:
		// Only when it is really installed: unloading a label we did not install is
		// somebody else's nightly backup to lose.
		if o.Agent == nil || !o.Agent.Installed() {
			return nil
		}
		return o.Agent.Uninstall()
	case KindBonjour:
		// Killing dns-sd IS the deregistration — mDNSResponder drops a registration when
		// the client that made it goes away (see supervisor.stopBonjour).
		if err := o.terminatePidfile(ctx, o.Layout.PidPath(services.Bonjour)); err != nil {
			return fmt.Errorf("%w: %w", errStillRunning, err)
		}
		return errors.Join(
			removeIfPresent(o.Layout.BonjourState),
			removeIfPresent(o.Layout.PidPath(services.Bonjour)),
		)
	case KindPidfiles:
		// Anything still alive here outlived its supervisor: a service orphaned by a
		// crash, which is precisely the "nothing dead left behind" case.
		{
			var survivors []error
			for _, name := range o.sweepOrder() {
				if err := o.terminatePidfile(ctx, filepath.Join(o.Layout.Pids, name)); err != nil {
					survivors = append(survivors, err)
				}
			}
			// The pidfiles stay: they are the only handle left on whatever would not go.
			if len(survivors) > 0 {
				return fmt.Errorf("%w: %w", errStillRunning, errors.Join(survivors...))
			}
		}
		return removeIfPresent(o.Layout.Pids)
	case KindData:
		// Through the symlink first, then the link itself: a data root relocated to
		// another volume is a link, and removing only that would report the household's
		// data deleted while every byte of it survived.
		return errors.Join(removeIfPresent(o.dataTarget()), removeIfPresent(it.Path))
	case KindSocket:
		return removeIfPresent(it.Path)
	}
	return nil
}

// dataTarget is the directory the data root really is. They differ only when the root is
// a symlink — a household moved to an external disk — and everything that measures or
// deletes the data has to work on the far side of it.
func (o Options) dataTarget() string {
	target, err := filepath.EvalSymlinks(o.Layout.Root)
	if err != nil {
		return o.Layout.Root
	}
	return target
}

// looksLikeDataDir asks whether this directory is one the runtime made. Any one of the
// three marks is enough: a data directory that was only ever laid out and never started
// has the folders but no config.env, and one restored by hand may have config.env and
// nothing else yet.
func (o Options) looksLikeDataDir() bool {
	return exists(o.Layout.ConfigEnv) || exists(o.Layout.RuntimeJSON) || exists(o.Layout.Postgres)
}

// unwrapMarker drops the internal marker prefix from a message meant for a person.
func unwrapMarker(err error) string {
	return strings.TrimPrefix(err.Error(), errStillRunning.Error()+": ")
}

func removeIfPresent(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}

func (o Options) inspect() Report {
	r := Report{
		Schema:  Schema,
		DataDir: o.Layout.Root,
		DryRun:  o.DryRun,
	}

	if o.Agent != nil {
		it := Item{
			Kind:    KindSchedule,
			Path:    o.Agent.PlistPath(),
			Action:  ActionRemove,
			Present: o.Agent.Installed(),
			Detail:  "the nightly backup launchd agent",
		}
		if it.Present {
			it.SizeBytes = fileSize(it.Path)
			// The launchd label is global: one Mac holds one nightly backup, belonging
			// to whichever data directory installed it. `Installed()` only says a
			// schedule exists, so uninstalling some OTHER data directory would boot out
			// the household's real backups and report it as a job done.
			// Fail closed: a plist we cannot attribute is left alone. Booting out the
			// global label on a guess would stop a household's real backups, and the
			// remedy for the rare unreadable plist is one explicit command
			// (`waffled-runtime backup --uninstall-schedule`).
			switch dir, err := o.Agent.ScheduledDataDir(); {
			case err != nil:
				it.Action = ActionKeep
				it.Detail = "kept: could not read which data directory it backs up (" + err.Error() + ")"
			case !sameDir(dir, o.Layout.Root):
				it.Action = ActionKeep
				it.Detail = "the nightly backup belongs to " + dir + ", not this data directory"
			}
		}
		r.Items = append(r.Items, it)
	}

	bonjourPid := o.Layout.PidPath(services.Bonjour)
	bonjour := Item{
		Kind:      KindBonjour,
		Path:      o.Layout.BonjourState,
		SizeBytes: fileSize(o.Layout.BonjourState),
		Action:    ActionRemove,
		Present:   exists(o.Layout.BonjourState) || exists(bonjourPid),
		Detail:    "the Bonjour advertisement of this server on the local network",
	}
	if pid, err := readPidfile(bonjourPid); err == nil && o.alive(pid) {
		bonjour.Detail = fmt.Sprintf("found advertising on the local network (dns-sd pid %d)", pid)
	}
	r.Items = append(r.Items, bonjour)

	// The details below are written in the past tense on purpose: the inventory is taken
	// before anything is stopped, and by the time the report is printed the server this
	// found running has usually been stopped by the run itself.
	pids := Item{
		Kind:      KindPidfiles,
		Path:      o.Layout.Pids,
		SizeBytes: dirSize(o.Layout.Pids),
		Action:    ActionRemove,
		Present:   exists(o.Layout.Pids),
		Detail:    "pidfiles left by the supervisor and its services",
	}
	if pid, running := o.supervisorPid(); running {
		r.foundRunning = true
		// Tense by mode: a dry run changes nothing, so the server it found is still up;
		// a real run has usually just stopped it.
		if o.DryRun {
			pids.Detail = fmt.Sprintf("the server is running (supervisor pid %d)", pid)
		} else {
			pids.Detail = fmt.Sprintf("the server was running (supervisor pid %d)", pid)
		}
	}
	r.Items = append(r.Items, pids)

	if socket, ok := o.socketItem(); ok {
		r.Items = append(r.Items, socket)
	}

	r.DataSizeBytes = dirSize(o.dataTarget())
	data := Item{
		Kind:      KindData,
		Path:      o.Layout.Root,
		SizeBytes: r.DataSizeBytes,
		Action:    ActionKeep,
		Present:   exists(o.Layout.Root),
		Detail:    "your household's database, photos, backups and config.env",
	}
	if o.DeleteData {
		data.Action = ActionRemove
		data.Detail = "your household's database, photos, backups and config.env — the secrets in config.env cannot be recovered"
	}
	r.Items = append(r.Items, data)
	return r
}

// socketItem describes the fallback directory Postgres put its socket in, when
// runtime.json records a plausible one. The second return is false when the record names
// nothing this command could have made — absent, relative, or somewhere the guards below
// rule out. A directory that IS ours is always reported, including when it is merely gone
// (present: false) or when its contents say to leave it alone: one Waffled made outside
// the data root and is leaving behind is exactly what a person needs told.
//
// runtime.json is the only record of it. Read best-effort: a runtime.json this build
// cannot parse is not a reason to refuse to uninstall.
func (o Options) socketItem() (Item, bool) {
	st, existed, err := rtstate.Load(o.Layout.RuntimeJSON)
	if err != nil || !existed || st.SocketDir == "" || st.SocketDir == o.Layout.Postgres {
		return Item{}, false
	}
	// Four guards, because this is the one path outside the data root that gets deleted
	// and it comes out of a file a person can edit. Three of them mean "this is not our
	// directory at all", and drop it: not absolute, inside the data root, or CONTAINING
	// it (a "wfl"-named parent would otherwise take the household's data with it). The
	// fourth — what is actually in there — downgrades the item to keep rather than
	// dropping it, because at that point it IS the directory we recorded.
	// Relative first: filepath.Rel errors when it compares an absolute root against a
	// relative path, and within() reads that error as "not contained", so a relative
	// path would slip past both guards below and be resolved against whatever the
	// working directory happened to be. The runtime only ever records an absolute one.
	if !filepath.IsAbs(st.SocketDir) {
		return Item{}, false
	}
	if within(o.Layout.Root, st.SocketDir) || within(st.SocketDir, o.Layout.Root) {
		return Item{}, false
	}
	if !strings.HasPrefix(filepath.Base(st.SocketDir), datadir.SocketDirPrefix) {
		return Item{}, false
	}

	it := Item{
		Kind:      KindSocket,
		Path:      st.SocketDir,
		SizeBytes: dirSize(st.SocketDir),
		Action:    ActionRemove,
		Present:   exists(st.SocketDir),
		Detail:    "Postgres's unix socket directory, outside the data folder because its path was too long",
	}
	// The name alone is not enough of a guard on a path that came out of a file a person
	// can edit. Anything else in there and the directory is reported and kept, not
	// deleted and not quietly dropped from the inventory.
	if it.Present {
		if why := notJustSockets(st.SocketDir); why != "" {
			it.Action = ActionKeep
			it.Detail = "recorded as Postgres's socket directory, kept because " + why
		}
	}
	return it, true
}

// notJustSockets says why a directory is not safe to remove, or "" when it holds nothing
// but Postgres's own socket and lock file — `.s.PGSQL.<port>` and `.s.PGSQL.<port>.lock`.
// An empty one qualifies: the postmaster removes the socket on a clean shutdown and
// leaves the directory behind.
func notJustSockets(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Sprintf("it could not be read (%v)", err)
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".s.PGSQL") {
			return "it holds files that are not Postgres sockets"
		}
	}
	return ""
}

// sameDir compares two directory paths, following symlinks where it can — the plist
// records the path as it was at install time, which may be a link.
func sameDir(a, b string) bool {
	clean := func(p string) string {
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			return resolved
		}
		return filepath.Clean(p)
	}
	return clean(a) == clean(b)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// supervisorPid reports the running supervisor, if there is one.
func (o Options) supervisorPid() (int, bool) {
	pid, err := readPidfile(o.Layout.PidPath(supervisor.SupervisorPidName))
	if err != nil {
		return 0, false
	}
	return pid, o.alive(pid)
}

// terminate asks a process to stop the way `stop` does — SIGTERM, wait, then kill.
func (o Options) terminate(ctx context.Context, pid int, grace time.Duration) error {
	if err := o.signal(pid, syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	if o.waitGone(ctx, pid, grace) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_ = o.signal(pid, syscall.SIGKILL)
	// SIGKILL is asynchronous: kill() returns before the kernel has torn the process
	// down and reaped it, so signal 0 keeps succeeding for a beat afterwards. Asking
	// straight away reports a process that really is going as one that will not go, and
	// that false failure goes on to block --delete-data. supervisor.stopOrphan pays a
	// flat 500ms here for the same reason.
	if o.waitGone(ctx, pid, killGrace) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		// Out of time, not unkillable — saying otherwise sends someone hunting a process
		// that was on its way out.
		return err
	}
	return fmt.Errorf("process %d will not exit", pid)
}

// waitGone polls until the process is gone, the window closes, or ctx is done.
func (o Options) waitGone(ctx context.Context, pid int, window time.Duration) bool {
	deadline := time.Now().Add(window)
	for {
		if !o.alive(pid) {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(pollInterval):
		}
	}
}

// sweepOrder lists the pidfiles in the order they should be signalled: the reverse of the
// dependency order supervisor.Stop walks, so Postgres goes last and the two services that
// hold connections to it are already gone. os.ReadDir alone is alphabetical, which puts
// postgres first — the database killed out from under powersync and caddy.
func (o Options) sweepOrder() []string {
	entries, err := os.ReadDir(o.Layout.Pids)
	if err != nil {
		return nil
	}
	present := map[string]bool{}
	for _, e := range entries {
		present[e.Name()] = true
	}
	var ordered []string
	for i := len(services.Order) - 1; i >= 0; i-- {
		if name := services.Order[i] + ".pid"; present[name] {
			ordered = append(ordered, name)
			delete(present, name)
		}
	}
	// Whatever is left — the supervisor's own pidfile, a service added since — in the
	// order ReadDir gave them.
	for _, e := range entries {
		if present[e.Name()] {
			ordered = append(ordered, e.Name())
		}
	}
	return ordered
}

// terminatePidfile stops whatever a pidfile names, if it is still alive.
//
// The error matters: everything above deletes the pidfile straight afterwards, and that
// file is the only remaining handle on an orphan. Reporting "removed" over a process
// that is still running would invert this package's whole reason for existing.
func (o Options) terminatePidfile(ctx context.Context, path string) error {
	pid, err := readPidfile(path)
	if err != nil {
		// A pidfile that is not there is nothing to stop. One that is there and cannot be
		// read is a process we cannot rule out, and treating it as nothing would delete
		// the directory and report "removed" over something possibly still running.
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("%s could not be read (%v) — delete it if nothing is running",
			filepath.Base(path), err)
	}
	if !o.alive(pid) {
		return nil
	}
	if err := o.terminate(ctx, pid, o.grace); err != nil {
		if errors.Is(err, syscall.EPERM) {
			// The same dead end refusal() explains for the supervisor: the pid belongs
			// to somebody else, so nothing this command can do will stop it. The pidfile
			// is left in place either way, which is exactly the way out.
			return fmt.Errorf("%s: pid %d belongs to another user — if it is not Waffled, "+
				"delete %s and run this again", filepath.Base(path), pid, path)
		}
		return fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return nil
}

// Text renders the inventory for a person: one line per item, and a closing paragraph
// that says in words where the data is and how to delete it.
func (r Report) Text() string {
	var b strings.Builder
	if r.DryRun {
		b.WriteString("Uninstall plan (dry run — nothing was changed)\n\n")
	} else {
		b.WriteString("Uninstall\n\n")
	}
	for _, it := range r.Items {
		state := "removed"
		switch {
		case it.Error != "":
			state = "failed"
		case !it.Present:
			state = "absent"
		case it.Action == ActionKeep:
			state = "kept"
		}
		if r.DryRun && it.Present {
			state = map[string]string{ActionRemove: "remove", ActionKeep: "keep"}[it.Action]
		}
		size := ""
		if it.SizeBytes > 0 {
			size = " (" + humanBytes(it.SizeBytes) + ")"
		}
		fmt.Fprintf(&b, "  %-8s %-9s %s%s\n", state, it.Kind, it.Path, size)
		detail := it.Detail
		if it.Error != "" {
			detail = it.Error
		}
		if detail != "" {
			// A joined error carries newlines — one per orphan that would not go — and
			// every line of it belongs in the same column as the first.
			for _, line := range strings.Split(detail, "\n") {
				fmt.Fprintf(&b, "  %-8s %-9s %s\n", "", "", line)
			}
		}
	}

	data := r.item(KindData)
	b.WriteString("\n")
	switch {
	case !data.Present:
		fmt.Fprintf(&b, "There is no Waffled data directory at %s.\n", r.DataDir)
	case data.Error != "":
		fmt.Fprintf(&b, "Your Waffled data at %s (%s) was NOT deleted: %s\n",
			r.DataDir, humanBytes(r.DataSizeBytes), data.Error)
	case data.Action == ActionKeep:
		verb := "is kept"
		if r.DryRun {
			verb = "would be kept"
		}
		fmt.Fprintf(&b, "Your Waffled data %s at %s (%s) — the database, media, backups and config.env.\n",
			verb, r.DataDir, humanBytes(r.DataSizeBytes))
		b.WriteString("Delete it too with: waffled-runtime uninstall --delete-data\n")
	default:
		verb := "was deleted"
		if r.DryRun {
			verb = "would be deleted"
		}
		fmt.Fprintf(&b, "Your Waffled data at %s (%s) %s. The secrets in config.env cannot be recovered.\n",
			r.DataDir, humanBytes(r.DataSizeBytes), verb)
		if r.DryRun && r.foundRunning {
			// The real run refuses over a running server, so the plan must not read as a
			// promise the command would not keep.
			b.WriteString("The server is running, so the real run will refuse: stop it first, or pass --yes.\n")
		}
	}
	return b.String()
}

// JSON is the --json document.
func (r Report) JSON() ([]byte, error) {
	if r.Items == nil {
		r.Items = []Item{}
	}
	return json.MarshalIndent(r, "", "  ")
}

func (r Report) item(kind string) Item {
	for _, it := range r.Items {
		if it.Kind == kind {
			return it
		}
	}
	return Item{Kind: kind}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func fileSize(path string) int64 {
	info, err := os.Lstat(path)
	if err != nil || info.IsDir() {
		return 0
	}
	return info.Size()
}

// dirSize adds up the regular files under a directory.
//
// Symlinks are not followed: a link into somebody's Photos library would otherwise be
// reported as the household's own data, and a link that points back inside the root
// would count twice. It is best-effort — an unreadable subdirectory or a live unix
// socket must not stop an uninstall — and it lives here rather than anywhere on the
// `status` path, which is polled and must stay cheap (apps/mac/CLAUDE.md).
func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for rest := n / unit; rest >= unit; rest /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func readPidfile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("%s does not contain a pid", path)
	}
	return pid, nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	// EPERM means it exists but belongs to someone else — a second account on a shared
	// Mac, or a root LaunchDaemon. Reading that as "dead" would walk the refusal below
	// straight past a live server. Same answer as supervisor.processAlive, deliberately.
	return errors.Is(err, syscall.EPERM)
}

func signalPid(pid int, sig syscall.Signal) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(sig)
}
