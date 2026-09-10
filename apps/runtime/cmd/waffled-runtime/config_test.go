package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readConfig(t *testing.T, dir string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "config.env"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestConfigSetCreatesTheFileAtOwnerOnlyPermissions(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "ANTHROPIC_API_KEY=sk-secret", "--data", dir}); err != nil {
		t.Fatal(err)
	}

	if got := readConfig(t, dir); !strings.Contains(got, "ANTHROPIC_API_KEY=sk-secret\n") {
		t.Fatalf("config.env does not carry the key:\n%s", got)
	}
	info, err := os.Stat(filepath.Join(dir, "config.env"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config.env is %o, want 600 — it holds provider keys", perm)
	}
}

// The data directory does not exist before the first `start`, and writing a key is the
// one thing that happens before it: the setup window collects a provider key on the
// screen ahead of the button.
func TestConfigSetCreatesTheDataDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not", "there", "yet")
	if err := run([]string{"config", "set", "OPENAI_API_KEY=sk-x", "--data", dir}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.env")); err != nil {
		t.Fatal(err)
	}
}

// Idempotent in the sense that matters: the key's line is replaced, and everything the
// operator put in the file by hand survives.
func TestConfigSetReplacesTheKeyAndKeepsEverythingElse(t *testing.T) {
	dir := t.TempDir()
	seed := "# hand-written\nLOCAL_JWT_SECRET=keep-me\nANTHROPIC_API_KEY=old\nTZ=Europe/London\n"
	if err := os.WriteFile(filepath.Join(dir, "config.env"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := run([]string{"config", "set", "ANTHROPIC_API_KEY=new", "--data", dir}); err != nil {
		t.Fatal(err)
	}

	got := readConfig(t, dir)
	for _, want := range []string{"# hand-written\n", "LOCAL_JWT_SECRET=keep-me\n", "ANTHROPIC_API_KEY=new\n", "TZ=Europe/London\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("lost %q from config.env:\n%s", want, got)
		}
	}
	if strings.Contains(got, "ANTHROPIC_API_KEY=old") {
		t.Errorf("the old value is still there:\n%s", got)
	}
	if n := strings.Count(got, "ANTHROPIC_API_KEY="); n != 1 {
		t.Errorf("the key appears %d times, want 1:\n%s", n, got)
	}
}

// A value with an `=` in it is ordinary — a base64 secret ends in one — and must not be
// cut short at the first separator.
func TestConfigSetKeepsAnEqualsSignInTheValue(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "TOKEN_ENCRYPTION_KEY=abc==", "--data", dir}); err != nil {
		t.Fatal(err)
	}
	if got := readConfig(t, dir); !strings.Contains(got, "TOKEN_ENCRYPTION_KEY=abc==\n") {
		t.Fatalf("the value was truncated:\n%s", got)
	}
}

func TestConfigSetRefusesAKeyThatIsNotAnEnvironmentName(t *testing.T) {
	for _, assignment := range []string{
		"lowercase=x",
		"9LEADING_DIGIT=x",
		"HAS-DASH=x",
		"HAS SPACE=x",
		"=x",
		"NO_EQUALS_SIGN",
	} {
		dir := t.TempDir()
		if err := run([]string{"config", "set", assignment, "--data", dir}); err == nil {
			t.Errorf("%q was accepted", assignment)
		}
		if _, err := os.Stat(filepath.Join(dir, "config.env")); err == nil {
			t.Errorf("%q was refused but still wrote config.env", assignment)
		}
	}
}

// config.env is line-oriented, so a newline in a value would silently become another
// assignment — or a truncated file. The custom host and the provider key both come from
// a text field a person can paste into.
func TestConfigSetRefusesANewlineInTheValue(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "WAFFLED_PUBLIC_HOST=one\ntwo", "--data", dir}); err == nil {
		t.Fatal("a value with a newline was accepted")
	}
	if err := run([]string{"config", "set", "WAFFLED_PUBLIC_HOST=one\rtwo", "--data", dir}); err == nil {
		t.Fatal("a value with a carriage return was accepted")
	}
}

// Go's flag package stops at the first non-flag argument, and the assignment is one, so
// `--data` written after it would otherwise be parsed as nothing at all — and the key
// would land in the household's real config.env instead of the one that was asked for.
func TestConfigSetParsesFlagsWrittenAfterTheAssignment(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "OPENAI_API_KEY=sk-x", "--data", dir}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.env")); err != nil {
		t.Fatalf("--data after the assignment was ignored: %v", err)
	}
}

func TestConfigSetParsesFlagsWrittenBeforeTheAssignment(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "--data", dir, "OPENAI_API_KEY=sk-x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.env")); err != nil {
		t.Fatalf("--data before the assignment was ignored: %v", err)
	}
}

func TestConfigSetParsesTheEqualsFormOfAFlag(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "OPENAI_API_KEY=sk-x", "--data=" + dir}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.env")); err != nil {
		t.Fatalf("--data=DIR after the assignment was ignored: %v", err)
	}
}

// The whole point of this command is that it carries secrets. A terminal it printed one
// into is a terminal someone scrolls back through, and a log the app captured.
func TestConfigSetNeverPrintsTheValue(t *testing.T) {
	dir := t.TempDir()
	out, err := captureStdout(t, func() error {
		return run([]string{"config", "set", "ANTHROPIC_API_KEY=sk-do-not-print", "--data", dir})
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "sk-do-not-print") {
		t.Fatalf("the value was printed:\n%s", out)
	}
	if !strings.Contains(out, "ANTHROPIC_API_KEY") {
		t.Fatalf("the key was not confirmed:\n%s", out)
	}
}

// An empty value is how a setting is cleared — "no custom host", "no provider key" —
// and it must reach the file as an empty assignment rather than being refused.
func TestConfigSetAcceptsAnEmptyValue(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "set", "WAFFLED_PUBLIC_HOST=", "--data", dir}); err != nil {
		t.Fatal(err)
	}
	if got := readConfig(t, dir); !strings.Contains(got, "WAFFLED_PUBLIC_HOST=\n") {
		t.Fatalf("the empty assignment is not there:\n%s", got)
	}
}

func TestConfigRefusesAnUnknownVerb(t *testing.T) {
	if err := run([]string{"config", "unset", "FOO"}); err == nil {
		t.Fatal("`config unset` was accepted")
	}
	if err := run([]string{"config"}); err == nil {
		t.Fatal("a bare `config` was accepted")
	}
}
