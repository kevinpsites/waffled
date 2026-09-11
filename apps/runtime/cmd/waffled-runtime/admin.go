package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

// `admin` is the break-glass operator CLI — the same `dist/admin.js` a Docker install
// reaches with `docker exec waffled-api node dist/admin.js`. Nothing here knows what its
// commands are: the arguments are forwarded verbatim, the exit code comes back, and the
// bundled CLI keeps being the one place they are documented.

const adminUsage = `waffled-runtime admin — break-glass operator commands

Usage:
  waffled-runtime admin [--data DIR] [--bundle DIR] <command> [args…]

The runtime's own flags come FIRST, before the command; everything from the command
onward belongs to the operator CLI. Use -- to end the runtime's flags explicitly.

  waffled-runtime admin list-members
  waffled-runtime admin reset-password --email you@example.com
  waffled-runtime admin make-admin --email you@example.com
  waffled-runtime admin prune-sessions --yes
  waffled-runtime admin help          the full command list

Waffled does not have to be running: if the server is stopped, Postgres is started for
the command and shut down again afterwards.
`

// adminEscape is where a person says "stop reading these as mine" — needed only for an
// operator command whose own argument is spelled like one of ours.
const adminEscape = "--"

// exitCodeError carries a child's exit status out to main without a message. The operator
// CLI has already printed its own, so main prints nothing and just exits with the code.
type exitCodeError struct{ code int }

func (e *exitCodeError) Error() string { return fmt.Sprintf("the admin command exited %d", e.code) }

func cmdAdmin(args []string) error {
	// Answered before anything is resolved: someone locked out types `help` first, and on
	// a Mac where Waffled has never started there is no database to open to say it.
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(adminUsage)
		return nil
	}

	runtimeArgs, adminArgs, err := splitAdminArgs(args)
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("admin", flag.ContinueOnError)
	common := addCommon(fs)
	if err := fs.Parse(runtimeArgs); err != nil {
		return err
	}
	// Flags and no command is a typo. Printing usage and exiting 0 would make a typed
	// command that did nothing look exactly like one that worked.
	if len(adminArgs) == 0 {
		return errors.New("usage: waffled-runtime admin [--data DIR] <command> [args…]; " +
			"`waffled-runtime admin help` lists the commands")
	}

	// A reader of this household's configuration, never its first run: a typo in --data
	// must not leave a half-built data directory behind. Tolerant of port conflicts for
	// the same reason `backup` is — admin does not listen on anything.
	s, err := newReader(common, supervisor.NewLogger(os.Stderr, false))
	if err != nil {
		return err
	}

	// No deadline: the CLI prompts for a typed confirmation. Ctrl-C has to arrive as a
	// cancelled context rather than Go's default exit, or the temporary Postgres this
	// command may have started is never shut down and collides with the next `start`.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	code, err := s.Admin(ctx, adminArgs, supervisor.AdminIO{In: os.Stdin, Out: os.Stdout, Err: os.Stderr})
	if err != nil {
		return err
	}
	if code != 0 {
		return &exitCodeError{code: code}
	}
	return nil
}

// splitAdminArgs divides `admin`'s arguments into the runtime's own flags and the argv to
// forward.
//
// Every other command with a positional hoists its flags (see hoistFlags); this one must
// not. Hoisting reorders, and `admin`'s positional is an opaque command line for another
// program — it would pull `--email you@example.com` out of the CLI's own arguments and
// hand it to a flag set that has never heard of it. So the rule is positional instead:
// the runtime's flags lead, and the first word that is not one of them ends them.
//
// What hoistFlags was written to prevent still has to be prevented, though — `restore
// dump --data DIR` silently restored over the DEFAULT household. Here that flag cannot be
// moved, so it is refused in words. `--` is the escape hatch for anyone who meant it.
func splitAdminArgs(args []string) (runtimeArgs, forward []string, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == adminEscape {
			return runtimeArgs, append(forward, args[i+1:]...), nil
		}
		name := strings.TrimLeft(arg, "-")
		key, _, hasValue := strings.Cut(name, "=")
		if len(arg) < 2 || arg[0] != '-' || !commonValueFlags[key] {
			// The command, and everything after it.
			forward = append(forward, args[i:]...)
			return runtimeArgs, forward, misplacedRuntimeFlag(forward)
		}
		runtimeArgs = append(runtimeArgs, arg)
		if !hasValue && i+1 < len(args) {
			i++
			runtimeArgs = append(runtimeArgs, args[i])
		}
	}
	return runtimeArgs, forward, nil
}

func misplacedRuntimeFlag(forward []string) error {
	for _, arg := range forward {
		name, _, _ := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if strings.HasPrefix(arg, "-") && commonValueFlags[name] {
			return fmt.Errorf("--%s is the runtime's own flag and belongs before the command, "+
				"as `waffled-runtime admin --%s DIR %s …`; everything after the command is passed "+
				"to the operator CLI (use -- if you really meant to pass it through)",
				name, name, forward[0])
		}
	}
	return nil
}
