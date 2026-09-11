package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// `admin` is the one command whose positional is an opaque argv for another program, so
// it must NOT hoist flags: hoisting would pull `--email a@b` out of admin.js's own
// command line and hand it to the runtime's flag set. splitAdminArgs draws the line
// instead — runtime flags lead, everything from the first word onward is forwarded.
func TestSplitAdminArgs(t *testing.T) {
	for _, c := range []struct {
		name             string
		args             []string
		runtime, forward []string
	}{
		{
			name:    "the runtime's flags lead and the rest is forwarded untouched",
			args:    []string{"--data", "/tmp/x", "reset-password", "--email", "a@b", "--yes"},
			runtime: []string{"--data", "/tmp/x"},
			forward: []string{"reset-password", "--email", "a@b", "--yes"},
		},
		{
			name:    "a flag carrying its own value swallows nothing after it",
			args:    []string{"--data=/tmp/x", "list-members"},
			runtime: []string{"--data=/tmp/x"},
			forward: []string{"list-members"},
		},
		{
			name:    "-- ends the runtime's flags, and what follows is forwarded as typed",
			args:    []string{"--data", "/tmp/x", "--", "--email", "a@b"},
			runtime: []string{"--data", "/tmp/x"},
			forward: []string{"--email", "a@b"},
		},
		{
			name:    "nothing at all forwards nothing",
			args:    nil,
			runtime: nil, forward: nil,
		},
		{
			// Flags and no command at all. The split is right; what must not happen is
			// further up, where a command that forwards nothing looks like a success.
			name:    "flags with no command forward nothing",
			args:    []string{"--data", "/tmp/x"},
			runtime: []string{"--data", "/tmp/x"}, forward: nil,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			runtimeArgs, forward, err := splitAdminArgs(c.args)
			if err != nil {
				t.Fatalf("splitAdminArgs: %v", err)
			}
			if !reflect.DeepEqual(runtimeArgs, c.runtime) {
				t.Errorf("runtime flags = %q, want %q", runtimeArgs, c.runtime)
			}
			if !reflect.DeepEqual(forward, c.forward) {
				t.Errorf("forwarded = %q, want %q", forward, c.forward)
			}
		})
	}
}

// The other half of the hoistFlags guarantee. `restore dump --data DIR` silently restored
// over the DEFAULT household; `admin list-members --data DIR` cannot be hoisted out of the
// way, so it is refused in words instead of quietly reading the wrong install.
func TestAdminRefusesARuntimeFlagAfterTheCommand(t *testing.T) {
	_, forward, err := splitAdminArgs([]string{"list-members", "--data", "/tmp/x"})
	if err == nil {
		t.Fatalf("--data after the command must be refused, got forward = %q", forward)
	}
	if !strings.Contains(err.Error(), "--data") {
		t.Errorf("the refusal must name the flag, got %v", err)
	}
	if !strings.Contains(err.Error(), "before") {
		t.Errorf("the refusal must say where the flag belongs, got %v", err)
	}
}

// The refusal shows the line to type instead, so the command it names has to be the
// operator command — not whatever word happened to come first. An unrecognised flag ends
// the runtime's own flags, so it can sit in front of the command being corrected.
func TestTheRefusalNamesTheOperatorCommandNotTheFirstWord(t *testing.T) {
	_, _, err := splitAdminArgs([]string{"--verbose", "--data", "/tmp/x", "list-members"})
	if err == nil {
		t.Fatal("--data after the command must be refused")
	}
	if !strings.Contains(err.Error(), "list-members") {
		t.Errorf("the example must name the real command, got %v", err)
	}
	if strings.Contains(err.Error(), "DIR --verbose") {
		t.Errorf("the example must not hand back an unusable command line, got %v", err)
	}
}

// `--` is the person saying "I meant that literally", so the refusal above steps aside.
func TestAdminForwardsARuntimeFlagNameAfterADoubleDash(t *testing.T) {
	_, forward, err := splitAdminArgs([]string{"--", "list-members", "--data", "/tmp/x"})
	if err != nil {
		t.Fatalf("-- must be an escape hatch: %v", err)
	}
	want := []string{"list-members", "--data", "/tmp/x"}
	if !reflect.DeepEqual(forward, want) {
		t.Errorf("forwarded = %q, want %q", forward, want)
	}
}

// Help is what a locked-out person types first. It must answer without a verified bundle
// and without a database — neither of which exists on the machine that is broken.
func TestAdminHelpNeedsNoBundleAndNoDatabase(t *testing.T) {
	for _, args := range [][]string{{"admin"}, {"admin", "help"}, {"admin", "--help"}} {
		out, err := captureStdout(t, func() error { return run(args) })
		if err != nil {
			t.Fatalf("%q: %v", args, err)
		}
		if !strings.Contains(out, "reset-password") {
			t.Errorf("%q printed no usage: %q", args, out)
		}
	}
}

// Flags but no command is a typo, not a request for help — and a typed command that does
// nothing while exiting 0 is the failure hoisting exists to prevent, in another shape.
func TestAdminWithFlagsButNoCommandIsRefused(t *testing.T) {
	err := run([]string{"admin", "--data", filepath.Join(t.TempDir(), "Waffled")})
	if err == nil {
		t.Fatal("a command that forwards nothing must not report success")
	}
	if !strings.Contains(err.Error(), "admin") {
		t.Errorf("the refusal must name the command it wanted, got %v", err)
	}
}

// Break-glass on a Mac where Waffled has never run must say so, not fail somewhere deep in
// node with a connection error.
func TestAdminRefusesWhenThereIsNoDatabaseYet(t *testing.T) {
	data := filepath.Join(t.TempDir(), "Waffled")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	err := run([]string{"admin", "--data", data, "--bundle", fakeBundle(t), "list-members"})
	if err == nil {
		t.Fatal("an install with no cluster must be refused")
	}
	if !strings.Contains(err.Error(), "no database") || !strings.Contains(err.Error(), "start") {
		t.Errorf("the refusal must say there is no database and point at `waffled-runtime start`, got %v", err)
	}
}

// admin is a reader of the data directory's configuration, never its first run. A typo in
// --data must not leave a half-built household behind — the same rule status/doctor follow.
func TestAdminDoesNotCreateADataDirectoryThatIsNotThere(t *testing.T) {
	data := filepath.Join(t.TempDir(), "not-there")
	if err := run([]string{"admin", "--data", data, "--bundle", fakeBundle(t), "list-members"}); err == nil {
		t.Fatal("a data directory that does not exist must be refused")
	}
	if _, err := os.Stat(data); err == nil {
		t.Fatalf("%s was created by a command that only reads", data)
	}
}
