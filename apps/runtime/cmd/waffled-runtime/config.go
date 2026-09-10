package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
)

// `config set` is how the Mac app writes a setting a person chose before the first
// `start` — a provider key, the address on the network, the preferred port. It goes
// through this binary rather than being written by the app so config.env has exactly one
// writer, with one idea of the file's mode and of what a valid assignment looks like.
//
// It deliberately does not build a Supervisor: nothing here needs the bundle, and the
// first thing the setup window does is write a key into a data directory that does not
// exist yet.

// envKey is the shape of an environment variable name. Anything else in config.env would
// be passed to a service that could not read it — or, with the wrong characters, would
// not be an assignment at all.
var envKey = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// commonValueFlags are the flags addCommon registers that take a separate argument. They
// are named here so hoistFlags knows which of them swallow the word after them.
var commonValueFlags = map[string]bool{"bundle": true, "data": true}

func cmdConfig(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: waffled-runtime config set KEY=VALUE [--data DIR]")
	}
	switch args[0] {
	case "set":
		return cmdConfigSet(args[1:])
	default:
		return fmt.Errorf("unknown config command %q; the only one is `set`", args[0])
	}
}

func cmdConfigSet(args []string) error {
	fs := flag.NewFlagSet("config set", flag.ContinueOnError)
	common := addCommon(fs)
	flags, positional := hoistFlags(args, commonValueFlags)
	if err := fs.Parse(flags); err != nil {
		return err
	}
	if len(positional) != 1 {
		return errors.New("usage: waffled-runtime config set KEY=VALUE [--data DIR]")
	}

	key, value, err := splitAssignment(positional[0])
	if err != nil {
		return err
	}
	layout, err := resolveLayout(common.data)
	if err != nil {
		return err
	}
	// Owner-only, the same mode Layout.Ensure gives the root. This runs before the first
	// start, so it is often the call that creates the directory the secrets will live in.
	if err := os.MkdirAll(layout.Root, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", layout.Root, err)
	}
	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		return err
	}
	env.Set(key, value)
	if err := env.Save(layout.ConfigEnv); err != nil {
		return err
	}
	// The key, never the value: this command's whole job is to carry secrets, and a
	// terminal is scrolled back through and a log is kept.
	fmt.Printf("Set %s in %s\n", key, layout.ConfigEnv)
	return nil
}

// splitAssignment reads KEY=VALUE, refusing anything config.env could not hold.
func splitAssignment(raw string) (key, value string, err error) {
	key, value, found := strings.Cut(raw, "=")
	if !found {
		return "", "", fmt.Errorf("%q is not KEY=VALUE", raw)
	}
	if !envKey.MatchString(key) {
		return "", "", fmt.Errorf("%q is not an environment variable name "+
			"(upper case, starting with a letter, then letters, digits or underscores)", key)
	}
	// config.env is one assignment per line, so a newline in a value would silently
	// become a second assignment — or truncate the file at the parser's next read.
	if strings.ContainsAny(value, "\n\r") {
		return "", "", fmt.Errorf("the value for %s contains a line break, which config.env cannot hold", key)
	}
	return key, value, nil
}

// resolveLayout is the data directory half of newSupervisor, without the bundle: the
// commands that only touch config.env must work before anything has been installed.
func resolveLayout(dataDir string) (datadir.Layout, error) {
	if dataDir == "" {
		return datadir.Default()
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return datadir.Layout{}, fmt.Errorf("resolve %s: %w", dataDir, err)
	}
	return datadir.At(abs), nil
}

// hoistFlags moves the flags in front of the positional arguments.
//
// Go's flag package stops parsing at the first non-flag argument, and `config set`'s
// argument is one — so `config set KEY=VALUE --data DIR` would otherwise write into the
// household's real config.env while reporting success. The app writes its flags last
// (RuntimeClient appends --bundle/--data to every call) and a person typing the command
// will write them wherever reads best; both have to mean the same thing.
func hoistFlags(args []string, takesValue map[string]bool) (flags, positional []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return flags, append(positional, args[i+1:]...)
		}
		if len(arg) < 2 || arg[0] != '-' {
			positional = append(positional, arg)
			continue
		}
		flags = append(flags, arg)
		name := strings.TrimLeft(arg, "-")
		if strings.ContainsRune(name, '=') {
			continue // --data=DIR carries its own value
		}
		if takesValue[name] && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return flags, positional
}
