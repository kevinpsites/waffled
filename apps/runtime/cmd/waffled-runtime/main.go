// Command waffled-runtime supervises a native Waffled server on this machine — the
// job Docker Compose does on Linux.
//
//	waffled-runtime start [--foreground] [--bundle DIR] [--data DIR]
//	waffled-runtime stop
//	waffled-runtime status [--json]
//	waffled-runtime logs [service] [-f] [-n N]
//	waffled-runtime doctor [--json]
//	waffled-runtime uninstall [--delete-data] [--dry-run] [--json] [--yes]
//	waffled-runtime version
//
// It is a CLI first, deliberately: everything the menu-bar app does, support can ask
// someone to do in Terminal.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
	"github.com/kevinpsites/waffled/apps/runtime/internal/uninstall"
)

// version is stamped at build time (-ldflags "-X main.version=..."); the bundle's own
// component versions come from its manifest and are shown by `status`.
var version = "dev"

const usage = `waffled-runtime — the Waffled server supervisor

Usage:
  waffled-runtime start [flags]     start the stack (detaches unless --foreground)
  waffled-runtime stop [flags]      stop the stack, in reverse order
  waffled-runtime status [flags]    what is running, on which ports
  waffled-runtime logs [service]    show a service log (postgres, migrate, api, powersync, caddy, bonjour, runtime)
  waffled-runtime backup [flags]    dump the database to the backups folder
  waffled-runtime restore FILE      replace the database with a dump (destructive)
  waffled-runtime doctor [flags]    diagnose a stack that will not start
  waffled-runtime uninstall [flags] remove what the runtime put on this Mac (keeps your data)
  waffled-runtime config set KEY=VALUE   write one setting into config.env
  waffled-runtime version

Common flags:
  --bundle DIR   the runtime bundle (default: the directory above this binary)
  --data DIR     the data directory (default: ~/Library/Application Support/Waffled)

start:
  --foreground   run the supervisor in this process — what launchd and the Mac app use
stop:
  --timeout D    how long to wait for a graceful shutdown (default 2m)
status, doctor:
  --json         machine-readable output
logs:
  -f             follow
  -n N           lines to show (default 200)
backup:
  --out FILE            write here instead of the backups folder (retention is then skipped)
  --keep N              how many backups to keep (default 14)
  --install-schedule    install a nightly 03:00 backup as a launchd agent
  --uninstall-schedule  remove it
restore:
  --yes          skip the typed confirmation (required when there is no terminal)
config set:
  KEY=VALUE      the setting to write; the key is upper case and the value is never
                 printed back. Creates the data directory and config.env if needed.
uninstall:
  --delete-data  also delete the data directory — the database, media, backups and the
                 secrets in config.env, which cannot be recovered (default: keep it)
  --dry-run      print the plan and change nothing
  --json         machine-readable output (schema 1)
  --yes          stop the server first if it is still running
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "✗ %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Print(usage)
		return errors.New("no command given")
	}
	switch args[0] {
	case "start":
		return cmdStart(args[1:])
	case "stop":
		return cmdStop(args[1:])
	case "status":
		return cmdStatus(args[1:])
	case "logs":
		return cmdLogs(args[1:])
	case "backup":
		return cmdBackup(args[1:])
	case "restore":
		return cmdRestore(args[1:])
	case "doctor":
		return cmdDoctor(args[1:])
	case "uninstall":
		return cmdUninstall(args[1:])
	case "config":
		return cmdConfig(args[1:])
	case "version", "--version", "-v":
		fmt.Printf("waffled-runtime %s\n", version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	default:
		fmt.Print(usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

type commonFlags struct {
	bundle string
	data   string
}

func addCommon(fs *flag.FlagSet) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.bundle, "bundle", "", "runtime bundle directory")
	fs.StringVar(&c.data, "data", "", "data directory")
	return c
}

// newSupervisor is where every command starts: it resolves the bundle, verifies it
// against its manifest, and settles config.env and the ports. A failure here is a
// failure to start, by design — nothing in the bundle runs until it matches what was
// built and signed.
func newSupervisor(c *commonFlags, log *supervisor.Logger) (*supervisor.Supervisor, error) {
	return supervisor.New(supervisor.Options{BundleDir: c.bundle, DataDir: c.data, Log: log})
}

// newInspector is newSupervisor for the read-only commands. They must still work when
// something has taken one of our ports — that is precisely when someone runs them — so
// a conflict becomes a reported fault rather than a refusal to start up at all.
func newInspector(c *commonFlags, log *supervisor.Logger) (*supervisor.Supervisor, error) {
	return supervisor.New(supervisor.Options{
		BundleDir: c.bundle, DataDir: c.data, Log: log, TolerateConflicts: true,
	})
}

func cmdStart(args []string) error {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	common := addCommon(fs)
	foreground := fs.Bool("foreground", false, "run the supervisor in this process")
	if err := fs.Parse(args); err != nil {
		return err
	}

	log := supervisor.NewLogger(os.Stderr, false)
	s, err := newSupervisor(common, log)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if *foreground {
		return s.RunForeground(ctx)
	}

	// Detached: re-exec ourselves with --foreground in a new session, then wait until
	// the public port answers so this command returns only when the server is usable.
	if _, err := s.StartDetached(ctx, nil); err != nil {
		return err
	}
	fmt.Printf("Waffled is running → %s\n", s.LocalURL())
	if lan := s.LANURL(); lan != "" {
		fmt.Printf("On your network:     %s\n", lan)
	}
	return nil
}

func cmdStop(args []string) error {
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	common := addCommon(fs)
	timeout := fs.Duration("timeout", 2*time.Minute, "how long to wait for a graceful shutdown")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// Tolerant, like status and doctor: if a service died and something else grabbed its
	// port, refusing to construct would leave `stop` unable to shut down the services
	// that ARE still running — the command whose whole job is freeing ports, blocked by
	// a port being occupied.
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, false))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout+30*time.Second)
	defer cancel()
	return s.StopDetached(ctx, *timeout)
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommon(fs)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// Status must not narrate; it is parsed.
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, true))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	report := s.Status(ctx)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Print(report.Text())
	return nil
}

func cmdBackup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	common := addCommon(fs)
	out := fs.String("out", "", "write the dump here instead of the backups folder")
	keep := fs.Int("keep", 0, "how many backups to keep (default 14)")
	install := fs.Bool("install-schedule", false, "install the nightly backup launchd agent")
	uninstall := fs.Bool("uninstall-schedule", false, "remove the nightly backup launchd agent")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *install && *uninstall {
		return errors.New("--install-schedule and --uninstall-schedule are opposites; pick one")
	}

	// Tolerant, like status and doctor. Backing up needs Postgres and nothing else, so a
	// port conflict on Caddy's public site — someone else's Docker holding 8080, say —
	// must not be what stops the 03:00 job from protecting the data.
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, false))
	if err != nil {
		return err
	}

	if *install || *uninstall {
		agent, err := s.BackupAgent()
		if err != nil {
			return err
		}
		if *uninstall {
			if err := agent.Uninstall(); err != nil {
				return err
			}
			fmt.Printf("Removed the nightly backup (%s)\n", agent.PlistPath())
			return nil
		}
		if err := agent.Install(); err != nil {
			return err
		}
		fmt.Printf("Waffled will back up nightly at %02d:%02d → %s\n",
			schedule.Hour, schedule.Minute, s.Plan().Layout.Backups)
		fmt.Printf("  agent: %s\n", agent.PlistPath())
		fmt.Printf("  log:   %s\n", s.Plan().Layout.LogPath("backup"))
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	path, err := s.Backup(ctx, supervisor.BackupOptions{Out: *out, Keep: *keep})
	if err != nil {
		return err
	}
	fmt.Println(path)
	return nil
}

func cmdRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	common := addCommon(fs)
	yes := fs.Bool("yes", false, "skip the typed confirmation")
	if err := fs.Parse(args); err != nil {
		return err
	}
	file := fs.Arg(0)
	if file == "" {
		return errors.New("usage: waffled-runtime restore FILE [--yes]")
	}

	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, false))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
	defer cancel()

	if err := s.Restore(ctx, supervisor.RestoreOptions{
		File: file, Yes: *yes, Confirm: confirmOnTTY,
	}); err != nil {
		return err
	}

	// Restore deliberately leaves the stack down with Postgres up. Starting it again
	// here — detached, so the supervisor outlives this command — is what re-runs the
	// migrations that catch an older dump up, rebuilds PowerSync's buckets from the
	// restored data, and gates on health before saying anything worked.
	fmt.Println("Restarting the server…")
	if _, err := s.StartDetached(ctx, nil); err != nil {
		return fmt.Errorf("the database was restored, but the server did not come back up: %w", err)
	}
	fmt.Printf("Restored. Waffled is running → %s\n", s.LocalURL())
	return nil
}

// confirmOnTTY asks for a typed confirmation, and only when there is a terminal to ask
// on. Without one it returns false, so a script that meant to pass --yes is refused
// rather than silently destroying a database — the repo-root `waffled` script's `[ -t 0 ]`
// check, with the non-interactive default turned from "proceed" into "stop".
func confirmOnTTY(prompt string) bool {
	st, err := os.Stdin.Stat()
	if err != nil || st.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	fmt.Print(prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	return strings.TrimSpace(line) == "restore"
}

func cmdDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	common := addCommon(fs)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, true))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	checks := s.Doctor(ctx)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(checks)
	}
	text, failed := supervisor.DoctorText(checks)
	fmt.Print(text)
	if failed {
		return errors.New("doctor found problems")
	}
	return nil
}

// cmdUninstall removes what the runtime put on this machine. It is the machine-level
// half of the Mac app's "Remove Waffled…"; the app's own half (login item, preferences,
// Sparkle caches, the .app) is not this command's job — see the README.
//
// It does not build a Supervisor. Doing so would write to the directory it is about to
// report on — the layout, config.env, runtime.json, bundle-verified.json — which would
// make --dry-run a lie and a second run find a data directory it had just recreated.
func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	common := addCommon(fs)
	deleteData := fs.Bool("delete-data", false, "also delete the data directory")
	dryRun := fs.Bool("dry-run", false, "print the plan and change nothing")
	asJSON := fs.Bool("json", false, "machine-readable output")
	yes := fs.Bool("yes", false, "stop the server first if it is running")
	if err := fs.Parse(args); err != nil {
		return err
	}

	root := common.data
	if root == "" {
		var err error
		if root, err = datadir.DefaultRoot(); err != nil {
			return err
		}
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	layout := datadir.At(root)

	opts := uninstall.Options{
		Layout:     layout,
		Agent:      backupSchedule(common.bundle, layout),
		DeleteData: *deleteData,
		DryRun:     *dryRun,
		Yes:        *yes,
		// Narration goes to stderr so --json owns stdout.
		Log: os.Stderr,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	report, runErr := uninstall.Run(ctx, opts)
	// A refusal is raised before anything is attempted, so there is no outcome to print.
	// Every other failure is partial by nature — some items removed, some not — and the
	// report is the only way to tell those apart from "nothing happened".
	if errors.Is(runErr, uninstall.ErrRefused) {
		return runErr
	}
	if *asJSON {
		doc, err := report.JSON()
		if err != nil {
			return err
		}
		fmt.Println(string(doc))
	} else {
		fmt.Print(report.Text())
	}
	return runErr
}

// backupSchedule builds the nightly-backup agent for an uninstall. Only its label,
// LaunchAgents directory and the data directory recorded in the installed plist matter
// here, so a binary or bundle path that cannot be resolved — the app already dragged to
// the Trash — is not a reason to stop; nil simply means "leave the schedule out of the
// inventory".
func backupSchedule(bundle string, layout datadir.Layout) uninstall.ScheduleAgent {
	exe, err := os.Executable()
	if err != nil {
		exe = ""
	}
	agent, err := schedule.For(exe, bundle, layout.Root, layout.LogPath("backup"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "! could not locate ~/Library/LaunchAgents: %v\n", err)
		return nil
	}
	return agent
}

func cmdLogs(args []string) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	common := addCommon(fs)
	follow := fs.Bool("f", false, "follow the log")
	lines := fs.Int("n", 200, "number of lines to show")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := newInspector(common, supervisor.NewLogger(io.Discard, true))
	if err != nil {
		return err
	}
	layout := s.Plan().Layout

	name := fs.Arg(0)
	if name == "" {
		entries, err := os.ReadDir(layout.Logs)
		if err != nil {
			return fmt.Errorf("no logs yet in %s", layout.Logs)
		}
		fmt.Printf("logs in %s:\n", layout.Logs)
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".log") {
				info, _ := e.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				fmt.Printf("  %-12s %8.1f KB\n", strings.TrimSuffix(e.Name(), ".log"), float64(size)/1024)
			}
		}
		return nil
	}

	path := layout.LogPath(name)
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no log for %q (try: %s, or runtime)", name,
			strings.Join(append(services.Order, services.Migrate, services.Bonjour), ", "))
	}
	return tailFile(path, *lines, *follow)
}

// tailFile prints the last n lines and, with follow, keeps printing as the file grows.
func tailFile(path string, n int, follow bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	all := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(all) > n {
		all = all[len(all)-n:]
	}
	for _, line := range all {
		fmt.Println(line)
	}
	if !follow {
		return nil
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return followFile(ctx, path, os.Stdout, followPoll)
}

const followPoll = 250 * time.Millisecond

// followFile streams everything appended to path until ctx is cancelled.
//
// It re-opens the path rather than seeking when the file changes underneath it.
// Seeking is not enough: rotateIfLarge renames <service>.log to <service>.log.1 and the
// restarted service opens a fresh file at the old name, so a follower holding the old
// descriptor would replay the renamed inode and then sit at EOF forever while every new
// line went to a file it never opened. os.SameFile is the test, not size — a
// replacement file that has already grown past the old offset is a rotation too.
func followFile(ctx context.Context, path string, out io.Writer, poll time.Duration) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { f.Close() }()
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}

	buf := make([]byte, 32*1024)
	drain := func() {
		for {
			n, err := f.Read(buf)
			if n > 0 {
				out.Write(buf[:n])
				offset += int64(n)
			}
			if err != nil || n == 0 {
				return
			}
		}
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(poll):
		}
		// Whatever the old file still holds belongs to the reader — drain it before
		// looking at whether it has been replaced.
		drain()

		st, err := os.Stat(path)
		if err != nil {
			continue
		}
		cur, curErr := f.Stat()
		switch {
		case curErr != nil || !os.SameFile(st, cur):
			// Rotated: the name now points at a different file. Re-open it, because the
			// descriptor we hold is the renamed .1 and nothing more will ever arrive on
			// it. Size is no help here — the replacement may already be the larger file.
			next, err := os.Open(path)
			if err != nil {
				continue // mid-rename; try again on the next tick
			}
			f.Close()
			f = next
			offset = 0
			drain()
		case st.Size() < offset:
			// Truncated in place: same file, fewer bytes. Start again from its beginning.
			offset = 0
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				return err
			}
			drain()
		}
	}
}
