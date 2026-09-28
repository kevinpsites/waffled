package services

import (
	"strconv"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
)

// The dump and restore tools, built the same way the psql forms are: from one shared
// connection prefix, so a flag added to one can never silently reshape another.
//
// Every value here traces to infra/compose/backup/backup.sh and the repo-root `waffled`
// script's restore case. The one deliberate difference is the format: the Compose sidecar
// writes plain SQL through gzip, and this writes pg_dump's custom format. Custom format
// is what lets `restore` read a dump's migration level out of it before committing to
// anything — pg_restore can extract one table's data, and a gzipped script cannot be
// asked anything at all without decompressing the whole thing. Plain dumps are still
// accepted on the way in, which is the Docker-to-Mac migration path.

// pgConnArgs is the loopback connection every tool shares.
func (p Plan) pgConnArgs() []string {
	return []string{
		"-h", "127.0.0.1",
		"-p", strconv.Itoa(p.Ports.Postgres),
		"-U", p.Env.PostgresUser(),
	}
}

// pgEnv carries the password out of argv. `ps` is world-readable on macOS, so a
// postgres:// URL on a command line publishes the database password to every process.
func (p Plan) pgEnv() []string {
	return append(p.baseEnv(), "PGPASSWORD="+p.Env.Get(configenv.KeyPostgresPassword))
}

// PgDump writes a custom-format dump of one database to a file.
//
// --no-owner and --no-privileges match the Compose sidecar: they are what let a dump
// taken on one install restore cleanly under a different role on another, which is the
// whole point of a backup someone might carry to a new Mac.
func (p Plan) PgDump(database, out string) Spec {
	bin := p.PostgresBin("pg_dump")
	args := append([]string{bin}, p.pgConnArgs()...)
	args = append(args,
		"-d", database,
		"--format=custom",
		"--no-owner",
		"--no-privileges",
		"--file", out,
	)
	return Spec{Name: "pg_dump", Path: bin, Args: args, Env: p.pgEnv(), OneShot: true}
}

// PgRestore loads a custom-format dump into an existing (empty) database.
//
// --single-transaction is the Compose restore's `psql --single-transaction`: all or
// nothing, so a restore that fails halfway never leaves a household looking at half a
// database. It implies --exit-on-error.
func (p Plan) PgRestore(database, file string) Spec {
	bin := p.PostgresBin("pg_restore")
	args := append([]string{bin}, p.pgConnArgs()...)
	args = append(args,
		"-d", database,
		"--no-owner",
		"--no-privileges",
		"--single-transaction",
		file,
	)
	return Spec{Name: "pg_restore", Path: bin, Args: args, Env: p.pgEnv(), OneShot: true}
}

// PgRestoreTable emits one table's data from a dump as SQL on stdout, connecting to
// nothing. It is how a dump's schema level is read before any decision is made about it:
// pg_restore's table of contents names the pgmigrations table but not its rows, so the
// only way to learn the level is to unpack that one table.
func (p Plan) PgRestoreTable(file, table string) Spec {
	bin := p.PostgresBin("pg_restore")
	args := []string{
		bin,
		"--data-only",
		"--table", table,
		"--file", "-", // stdout
		file,
	}
	return Spec{Name: "pg_restore", Path: bin, Args: args, Env: p.pgEnv(), OneShot: true}
}

// PsqlStdin runs a SQL script arriving on stdin — how a plain (or gunzipped) dump from
// the Compose backup sidecar is restored, matching that path's own
// `psql -v ON_ERROR_STOP=1 --single-transaction`.
func (p Plan) PsqlStdin(database string) Spec {
	psql := p.PostgresBin("psql")
	args := append([]string{psql}, p.pgConnArgs()...)
	args = append(args,
		"-d", database,
		"-v", "ON_ERROR_STOP=1",
		"--single-transaction",
		"--no-psqlrc",
		"--quiet",
	)
	return Spec{Name: "psql", Path: psql, Args: args, Env: p.pgEnv(), OneShot: true}
}
