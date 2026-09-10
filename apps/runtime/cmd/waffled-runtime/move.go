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
	if _, err := os.Stat(layout.Root); err != nil {
		return fmt.Errorf("there is no Waffled data directory at %s", layout.Root)
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
	if errors.Is(err, relocate.ErrOldFolderRemains) {
		if reportErr := reportMove(plan, *asJSON, false); reportErr != nil {
			return reportErr
		}
		fmt.Fprintf(os.Stderr, "! %v\n", err)
		return nil
	}
	if err != nil {
		return err
	}
	return reportMove(plan, *asJSON, false)
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
