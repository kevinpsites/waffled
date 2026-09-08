package services

import (
	"strings"
	"testing"
)

// PsqlCommand used to build Psql(database, "") and then slice off the last two args to
// drop the trailing `-f ""`. Nothing checked that assumption: appending any flag after
// `-f file` in Psql would have left PsqlCommand handing psql an empty -f alongside -tAc,
// breaking ensureDatabase, databaseExists, QueryScalar, Collation and doctor's wal_level
// check at runtime and in silence. These tests pin the shape both callers depend on.
func TestPsqlCommandEndsWithTheSingleStatementFlags(t *testing.T) {
	p := testPlan(t)
	spec := p.PsqlCommand("postgres", "show wal_level")

	args := spec.Args
	if len(args) < 3 {
		t.Fatalf("args are too short: %v", args)
	}
	tail := args[len(args)-3:]
	want := []string{"--no-psqlrc", "-tAc", "show wal_level"}
	for i := range want {
		if tail[i] != want[i] {
			t.Fatalf("args end with %v, want %v (full: %v)", tail, want, args)
		}
	}
	for _, a := range args {
		if a == "-f" {
			t.Errorf("PsqlCommand must not pass -f, got %v", args)
		}
	}
	if !spec.OneShot {
		t.Error("a single statement is a one-shot command")
	}
}

func TestPsqlRunsAFileAndPsqlCommandDoesNot(t *testing.T) {
	p := testPlan(t)
	spec := p.Psql("waffled", "/tmp/00-init.sql")

	args := spec.Args
	tail := args[len(args)-3:]
	want := []string{"--no-psqlrc", "-f", "/tmp/00-init.sql"}
	for i := range want {
		if tail[i] != want[i] {
			t.Fatalf("args end with %v, want %v (full: %v)", tail, want, args)
		}
	}
	for _, a := range args {
		if a == "-tAc" {
			t.Errorf("Psql must not pass -tAc, got %v", args)
		}
	}
}

// Both forms must carry the same connection: same host, port, user, database and
// ON_ERROR_STOP, and the password in the environment rather than in argv where every
// process on the Mac could read it from ps.
func TestBothPsqlFormsShareTheSameConnection(t *testing.T) {
	p := testPlan(t)
	file := p.Psql("waffled", "/tmp/x.sql")
	cmd := p.PsqlCommand("waffled", "select 1")

	base := func(args []string) string {
		// everything up to the trailing verb pair
		return strings.Join(args[:len(args)-2], " ")
	}
	if base(file.Args) != base(cmd.Args) {
		t.Errorf("connection args differ:\n  file: %s\n   cmd: %s", base(file.Args), base(cmd.Args))
	}
	for _, spec := range []Spec{file, cmd} {
		e := envMap(spec.Env)
		if e["PGPASSWORD"] == "" {
			t.Errorf("%v: the password must travel in PGPASSWORD", spec.Args)
		}
		for _, a := range spec.Args {
			if strings.Contains(a, e["PGPASSWORD"]) {
				t.Errorf("the password must not appear in argv: %v", spec.Args)
			}
		}
	}
}
