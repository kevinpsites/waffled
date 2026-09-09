package services

import (
	"strings"
	"testing"
)

// argAfter returns the value following flag in argv, so a test can assert on the pairing
// rather than on a whole-slice literal that every future flag would break.
func argAfter(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func hasArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestPgDumpUsesTheCustomFormatAndAPasswordEnvironment(t *testing.T) {
	p := testPlan(t)
	spec := p.PgDump("waffled", "/tmp/out.dump")

	if !strings.HasSuffix(spec.Path, "/bin/pg_dump") {
		t.Errorf("pg_dump resolved to %q, want the bundled binary", spec.Path)
	}
	if !spec.OneShot {
		t.Error("pg_dump is a one-shot")
	}
	// Custom format is what makes pg_restore --clean and selective extraction possible.
	// A plain-SQL dump could not be asked for its pgmigrations table alone.
	if !hasArg(spec.Args, "--format=custom") {
		t.Errorf("pg_dump is not taking a custom-format dump: %v", spec.Args)
	}
	for _, want := range []string{"--no-owner", "--no-privileges"} {
		if !hasArg(spec.Args, want) {
			t.Errorf("pg_dump is missing %s (the Compose sidecar passes it so a restore works "+
				"under any role): %v", want, spec.Args)
		}
	}
	if got, _ := argAfter(spec.Args, "--file"); got != "/tmp/out.dump" {
		t.Errorf("--file = %q, want /tmp/out.dump", got)
	}
	if got, _ := argAfter(spec.Args, "-d"); got != "waffled" {
		t.Errorf("-d = %q, want waffled", got)
	}

	// The password must travel in the environment, never in argv: every process on this
	// Mac can read another's command line out of `ps`.
	joined := strings.Join(spec.Args, " ")
	if strings.Contains(joined, p.Env.Get("POSTGRES_PASSWORD")) {
		t.Errorf("the postgres password is visible in argv: %v", spec.Args)
	}
	var sawPassword bool
	for _, e := range spec.Env {
		if strings.HasPrefix(e, "PGPASSWORD=") {
			sawPassword = true
		}
	}
	if !sawPassword {
		t.Error("pg_dump was given no PGPASSWORD, so it would prompt and hang")
	}
}

func TestPgRestoreCleansAndRunsInOneTransaction(t *testing.T) {
	p := testPlan(t)
	spec := p.PgRestore("waffled", "/tmp/in.dump")

	if !strings.HasSuffix(spec.Path, "/bin/pg_restore") {
		t.Errorf("pg_restore resolved to %q, want the bundled binary", spec.Path)
	}
	// All-or-nothing, like the Compose restore's `psql --single-transaction`: a restore
	// that fails halfway must not leave a household with half a database.
	if !hasArg(spec.Args, "--single-transaction") {
		t.Errorf("pg_restore is not restoring atomically: %v", spec.Args)
	}
	for _, want := range []string{"--no-owner", "--no-privileges"} {
		if !hasArg(spec.Args, want) {
			t.Errorf("pg_restore is missing %s: %v", want, spec.Args)
		}
	}
	if spec.Args[len(spec.Args)-1] != "/tmp/in.dump" {
		t.Errorf("the dump file should be the final argument: %v", spec.Args)
	}
}

// Reading a dump's schema level means extracting one table's data as SQL. pg_restore
// with no -d writes the script to stdout, which is what the migration parser reads.
func TestPgRestoreTableEmitsSQLToStdout(t *testing.T) {
	p := testPlan(t)
	spec := p.PgRestoreTable("/tmp/in.dump", "pgmigrations")

	if hasArg(spec.Args, "-d") {
		t.Errorf("extracting a table must not connect to a database: %v", spec.Args)
	}
	if !hasArg(spec.Args, "--data-only") {
		t.Errorf("extracting migration rows needs --data-only: %v", spec.Args)
	}
	if got, _ := argAfter(spec.Args, "--table"); got != "pgmigrations" {
		t.Errorf("--table = %q, want pgmigrations", got)
	}
	if got, _ := argAfter(spec.Args, "--file"); got != "-" {
		t.Errorf("--file = %q, want - (stdout)", got)
	}
}

// Plain SQL is what the Compose backup sidecar writes, so restoring one is the
// Docker-to-Mac migration path. It goes through psql on stdin, not pg_restore.
func TestPsqlStdinRestoresAPlainDump(t *testing.T) {
	p := testPlan(t)
	spec := p.PsqlStdin("waffled")

	if !strings.HasSuffix(spec.Path, "/bin/psql") {
		t.Errorf("psql resolved to %q", spec.Path)
	}
	if !hasArg(spec.Args, "--single-transaction") {
		t.Errorf("a plain restore must be atomic, like the Compose one: %v", spec.Args)
	}
	if !hasArg(spec.Args, "ON_ERROR_STOP=1") {
		t.Errorf("psql must stop on the first error: %v", spec.Args)
	}
	// No -f and no -c: the script arrives on stdin.
	if hasArg(spec.Args, "-f") || hasArg(spec.Args, "-c") || hasArg(spec.Args, "-tAc") {
		t.Errorf("PsqlStdin must take its script from stdin: %v", spec.Args)
	}
}
