package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/relocate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
)

// `move` takes a household's data directory somewhere else on this Mac — off a full
// startup disk, usually. Like `config set` it builds no supervisor: nothing here needs
// the bundle, and a move is exactly the moment the data directory is not where anything
// else expects it.
//
// It does NOT remember where it put things. `--data` is how every command is told, and
// the Mac app is what holds the household's answer between launches.

// moveValueFlags are the flags of this command that take a separate argument, for
// hoistFlags — Go's flag package stops at the first non-flag word.
var moveValueFlags = map[string]bool{"bundle": true, "data": true, "to": true}

func cmdMove(args []string) error {
	fs := flag.NewFlagSet("move", flag.ContinueOnError)
	common := addCommon(fs)
	to := fs.String("to", "", "the folder to move the data directory to")
	dryRun := fs.Bool("dry-run", false, "print what would happen and change nothing")
	asJSON := fs.Bool("json", false, "machine-readable output")
	flags, _ := hoistFlags(args, moveValueFlags)
	if err := fs.Parse(flags); err != nil {
		return err
	}
	if *to == "" {
		return errors.New("usage: waffled-runtime move --to DIR [--data DIR] [--dry-run] [--json]")
	}

	layout, err := resolveLayout(common.data)
	if err != nil {
		return err
	}
	// The same question `uninstall --delete-data` asks, for the same reason: every
	// read-only command lays the tree out before it knows whether a household lives
	// there, so a bare skeleton is not one. Moving one would copy nothing, delete the
	// scaffold, report success, and leave the real data where it was.
	if !looksLikeAHousehold(layout) {
		return fmt.Errorf("%s has none of Waffled's own files in it "+
			"(no config.env, runtime.json or a database) — there is nothing here to move",
			layout.Root)
	}
	target, err := filepath.Abs(*to)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", *to, err)
	}

	options := relocate.Options{Layout: layout, To: target}
	if *dryRun {
		plan, err := relocate.Inspect(options)
		if err != nil {
			return err
		}
		return reportMove(plan, *asJSON, true)
	}
	plan, err := relocate.Run(context.Background(), options)
	// The move working and the old folder failing to go is not a failed move: the
	// household is whole at the new address. Reporting it as a failure leaves whoever
	// asked pointing at the old folder — and a retry is then refused, because the
	// destination now "already has something in it".
	remains := errors.Is(err, relocate.ErrOldFolderRemains)
	if err != nil && !remains {
		return err
	}
	followed := followSchedule(common.bundle, layout.Root, plan.To)
	if reportErr := reportMove(plan, *asJSON, false); reportErr != nil {
		return reportErr
	}
	if followed && !*asJSON {
		fmt.Printf("The nightly backup moved with it: it now backs up %s\n", plan.To)
	}
	if remains {
		fmt.Fprintf(os.Stderr, "! %v\n", err)
	}
	return nil
}

// scheduleFollower is the part of *schedule.Agent a move uses. An interface for the
// reason uninstall's is: following re-installs the global launchd label, so no test may
// hold a real one.
type scheduleFollower interface {
	Follow(from string) (bool, error)
}

// newFollower builds the nightly-backup agent for the folder a household moved to.
var newFollower = func(bundle string, to datadir.Layout) (scheduleFollower, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	agent, err := schedule.For(exe, bundle, to.Root, to.LogPath("backup"))
	if err != nil {
		return nil, err
	}
	return agent, nil
}

// followSchedule points the nightly backup at the new folder when it was backing up the
// old one. Left alone, it would recreate the old folder empty every night and back that
// up, while the household went unprotected. A failure is said, not returned: the move
// itself has worked.
func followSchedule(bundle, from, to string) bool {
	agent, err := newFollower(bundle, datadir.At(to))
	if err == nil {
		var followed bool
		if followed, err = agent.Follow(from); err == nil {
			return followed
		}
	}
	fmt.Fprintf(os.Stderr, "! the nightly backup could not be pointed at %s: %v\n"+
		"  re-install it with: waffled-runtime backup --install-schedule --data %q\n", to, err, to)
	return false
}

// looksLikeAHousehold is uninstall's rule, asked here too: one of our own files, or a
// postgres directory with a cluster in it. An empty tree of our folders is not a
// household — older builds laid one out on every read-only look at a missing directory.
func looksLikeAHousehold(layout datadir.Layout) bool {
	if _, err := os.Stat(layout.ConfigEnv); err == nil {
		return true
	}
	if _, err := os.Stat(layout.RuntimeJSON); err == nil {
		return true
	}
	entries, err := os.ReadDir(layout.Postgres)
	return err == nil && len(entries) > 0
}

func reportMove(plan relocate.Plan, asJSON, planned bool) error {
	if asJSON {
		out, err := json.MarshalIndent(plan, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(out))
		return nil
	}
	if planned {
		fmt.Printf("Would move %s (%s) to %s\n", plan.From, datadir.HumanBytes(plan.Bytes), plan.To)
	} else {
		fmt.Printf("Moved %s (%s) to %s\n", plan.From, datadir.HumanBytes(plan.Bytes), plan.To)
	}
	if plan.ForgotSocketDir {
		fmt.Println("The remembered Postgres socket directory pointed into the old folder " +
			"and was cleared; the next start picks one from the new folder.")
	}
	// Said either way: nothing on this Mac now knows where the data directory went, and
	// the next command run without --data would look in the default place.
	fmt.Printf("Start Waffled again with: waffled-runtime start --data %q\n", plan.To)
	return nil
}
