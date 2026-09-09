package supervisor

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

const (
	pgStartTimeout = 60 * time.Second
	pgStopTimeout  = 60 * time.Second
)

// The two tmutil-backed calls go through package-level vars so the tests can count them
// rather than run tmutil against the machine holding the suite. Always the real
// functions in production; nothing outside a test ever reassigns them.
var (
	isExcludedFromBackup = datadir.IsExcludedFromBackup
	excludeFromBackup    = datadir.ExcludeFromBackup
)

// postgresInitialized reports whether PGDATA already holds a cluster.
func (s *Supervisor) postgresInitialized() bool {
	_, err := os.Stat(filepath.Join(s.plan.Layout.Postgres, "PG_VERSION"))
	return err == nil
}

// initPostgres creates the cluster on first run: initdb, the managed postgresql.conf
// block, a loopback-only pg_hba.conf, and the Time Machine exclusion on PGDATA.
func (s *Supervisor) initPostgres(ctx context.Context) error {
	if s.postgresInitialized() {
		return nil
	}
	s.log.Infof("first run: creating the database cluster in %s", s.plan.Layout.Postgres)

	// initdb insists on an empty directory it owns.
	if err := os.MkdirAll(s.plan.Layout.Postgres, 0o700); err != nil {
		return fmt.Errorf("create PGDATA: %w", err)
	}
	if err := os.Chmod(s.plan.Layout.Postgres, 0o700); err != nil {
		return fmt.Errorf("secure PGDATA: %w", err)
	}

	// The superuser password reaches initdb through a 0600 file rather than argv.
	pwfile := filepath.Join(s.plan.Layout.Root, ".initdb-password")
	if err := os.WriteFile(pwfile, []byte(s.plan.Env.Get(configenv.KeyPostgresPassword)+"\n"), 0o600); err != nil {
		return fmt.Errorf("stage the initdb password: %w", err)
	}
	defer os.Remove(pwfile)

	spec := services.Spec{
		Name:    "initdb",
		Path:    s.plan.PostgresBin("initdb"),
		Args:    append([]string{s.plan.PostgresBin("initdb")}, s.plan.InitdbArgs(pwfile)...),
		Env:     s.plan.PgIsReady().Env,
		OneShot: true,
	}
	if out, err := s.runOneShot(ctx, spec, 5*time.Minute); err != nil {
		return fmt.Errorf("initdb failed: %w\n%s", err, tail(out, 20))
	}

	if err := appendFile(filepath.Join(s.plan.Layout.Postgres, "postgresql.conf"), s.plan.PostgresConf()); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.plan.Layout.Postgres, "pg_hba.conf"), []byte(s.plan.PostgresHBA()), 0o600); err != nil {
		return fmt.Errorf("write pg_hba.conf: %w", err)
	}

	// The Time Machine exclusion is asserted in New(), when the data directory is
	// created — earlier than here, and on every install rather than only on the run that
	// happens to initdb. See excludeDataFromTimeMachine.
	return nil
}

// excludeDataFromTimeMachine marks PGDATA so Time Machine skips it.
//
// Restoring a live Postgres cluster from a file-level backup produces a corrupt one
// (plan §5), so the cluster is excluded and backups/ — a consistent pg_dump — is what
// gets backed up. tmutil is the documented interface and sets the
// com.apple.metadata:com_apple_backup_excludeItem xattr itself; the sticky form needs no
// admin rights on a path the user owns.
//
// It runs when the data directory is created rather than when the cluster is, so an
// install that predates this, or one where tmutil failed once, is repaired on its next
// start. Failing is always a warning: a household whose Time Machine is misconfigured
// should still get a server.
//
// The memo in runtime.json is trusted OUTRIGHT rather than verified against tmutil. This
// runs from New(), and `status` constructs a Supervisor on every poll — so re-asking here
// would fork /usr/bin/tmutil once a second behind the menu-bar app, which is the exact
// cost the memo was added to avoid. Someone who removes the exclusion by hand afterwards
// is caught by `doctor`, which asks tmutil live: re-asking settled questions is what that
// command is for, and it runs once when a human types it.
func (s *Supervisor) excludeDataFromTimeMachine() {
	if s.state.BackupExcluded {
		return
	}
	if err := excludeFromBackup(s.plan.Layout.Postgres); err != nil {
		s.log.Warnf("could not exclude the database from Time Machine: %v — "+
			"back up %s instead of restoring the live cluster", err, s.plan.Layout.Backups)
		return
	}
	s.log.Infof("excluded %s from Time Machine (%s is what gets backed up)",
		s.plan.Layout.Postgres, s.plan.Layout.Backups)
	s.state.BackupExcluded = true
}

// reconcilePostgresConf rewrites the managed block on every start, so a port that moved
// between runs takes effect rather than leaving the cluster on its old one.
func (s *Supervisor) reconcilePostgresConf() error {
	confPath := filepath.Join(s.plan.Layout.Postgres, "postgresql.conf")
	raw, err := os.ReadFile(confPath)
	if err != nil {
		return fmt.Errorf("read postgresql.conf: %w", err)
	}
	const marker = "# ── waffled-runtime ─"
	body := string(raw)
	if idx := strings.Index(body, marker); idx >= 0 {
		body = strings.TrimRight(body[:idx], "\n") + "\n"
	}
	body += s.plan.PostgresConf()
	if err := os.WriteFile(confPath, []byte(body), 0o600); err != nil {
		return fmt.Errorf("update postgresql.conf: %w", err)
	}
	// pg_hba is fully ours; rewrite it so a security fix reaches existing installs.
	return os.WriteFile(filepath.Join(s.plan.Layout.Postgres, "pg_hba.conf"), []byte(s.plan.PostgresHBA()), 0o600)
}

// startPostgres brings the cluster up through pg_ctl -w, which returns only once the
// postmaster accepts connections.
func (s *Supervisor) startPostgres(ctx context.Context) error {
	if pid, ok := s.postgresPid(); ok {
		s.log.Infof("postgres is already running (pid %d)", pid)
		return nil
	}
	// A stale postmaster.pid from an unclean shutdown stops pg_ctl dead.
	if pidPath := filepath.Join(s.plan.Layout.Postgres, "postmaster.pid"); fileExists(pidPath) {
		s.log.Warnf("removing a stale postmaster.pid from an unclean shutdown")
		_ = os.Remove(pidPath)
	}

	spec := s.plan.PgCtl("-w", "-t", "60", "-l", s.plan.Layout.LogPath(services.Postgres), "start")
	if out, err := s.runOneShot(ctx, spec, pgStartTimeout); err != nil {
		return fmt.Errorf("postgres failed to start: %w\n%s\nsee %s",
			err, tail(out, 10), s.plan.Layout.LogPath(services.Postgres))
	}
	// pg_ctl -w already waited, but pg_isready is the check compose's healthcheck runs
	// and the one `doctor` repeats, so gate on the same thing.
	if err := s.waitPgReady(ctx, 30*time.Second); err != nil {
		return err
	}
	pid, _ := s.postgresPid()
	s.log.Infof("postgres up on 127.0.0.1:%d (pid %d)", s.plan.Ports.Postgres, pid)
	return nil
}

func (s *Supervisor) waitPgReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastOut string
	for {
		out, err := s.runOneShot(ctx, s.plan.PgIsReady(), 10*time.Second)
		if err == nil {
			return nil
		}
		lastOut = strings.TrimSpace(out)
		if time.Now().After(deadline) {
			return fmt.Errorf("postgres did not become ready within %s: %s", timeout, lastOut)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// stopPostgres uses fast mode: roll back in-flight transactions and shut down promptly,
// rather than waiting for clients that Caddy and the api have already dropped.
func (s *Supervisor) stopPostgres(ctx context.Context) error {
	if _, ok := s.postgresPid(); !ok {
		return nil
	}
	spec := s.plan.PgCtl("-w", "-t", "60", "-m", "fast", "stop")
	if out, err := s.runOneShot(ctx, spec, pgStopTimeout); err != nil {
		return fmt.Errorf("pg_ctl stop: %w\n%s", err, tail(out, 10))
	}
	s.log.Infof("postgres stopped")
	return nil
}

// postgresPid reads the running postmaster's pid from PGDATA, which is how `status`
// finds it without having started it.
func (s *Supervisor) postgresPid() (int, bool) {
	raw, err := os.ReadFile(filepath.Join(s.plan.Layout.Postgres, "postmaster.pid"))
	if err != nil {
		return 0, false
	}
	lines := strings.SplitN(string(raw), "\n", 2)
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || pid <= 0 {
		return 0, false
	}
	if !processAlive(pid) {
		return 0, false
	}
	return pid, true
}

// initDatabases reproduces what the postgres:16 image does with POSTGRES_DB plus
// /docker-entrypoint-initdb.d: create the application database if absent, then run
// 00-init.sql against it. Both halves are idempotent, so this runs on every start and a
// half-finished first run repairs itself.
func (s *Supervisor) initDatabases(ctx context.Context) error {
	db := s.plan.Env.PostgresDB()
	exists, err := s.databaseExists(ctx, db)
	if err != nil {
		return err
	}
	if !exists {
		s.log.Infof("creating the %s database", db)
		create := s.plan.PsqlCommand("postgres", fmt.Sprintf(`create database %s`, quoteIdent(db)))
		if out, err := s.runOneShot(ctx, create, time.Minute); err != nil {
			return fmt.Errorf("create database %s: %w\n%s", db, err, tail(out, 10))
		}
	}

	// config/00-init.sql is the compose init script verbatim: pgcrypto plus the
	// powersync_storage database. psql understands its \set and \gexec directly.
	initSQL := filepath.Join(s.plan.Bundle, "config", "00-init.sql")
	if !fileExists(initSQL) {
		return fmt.Errorf("the bundle is missing config/00-init.sql at %s", initSQL)
	}
	if out, err := s.runOneShot(ctx, s.plan.Psql(db, initSQL), 2*time.Minute); err != nil {
		return fmt.Errorf("run 00-init.sql: %w\n%s", err, tail(out, 20))
	}
	return nil
}

func (s *Supervisor) databaseExists(ctx context.Context, name string) (bool, error) {
	spec := s.plan.PsqlCommand("postgres",
		fmt.Sprintf("select 1 from pg_database where datname = %s", quoteLiteral(name)))
	out, err := s.runOneShot(ctx, spec, time.Minute)
	if err != nil {
		return false, fmt.Errorf("check for the %s database: %w\n%s", name, err, tail(out, 10))
	}
	return strings.TrimSpace(out) == "1", nil
}

// QueryScalar runs a single-value query through the bundled psql and returns the result
// as text. It is how this package (and `doctor`, and backup/restore) asks the
// database a question without taking on a Postgres driver dependency.
func (s *Supervisor) QueryScalar(ctx context.Context, database, sql string) (string, error) {
	out, err := s.runOneShot(ctx, s.plan.PsqlCommand(database, sql), time.Minute)
	if err != nil {
		return "", fmt.Errorf("query %s: %w\n%s", database, err, tail(out, 10))
	}
	return strings.TrimSpace(out), nil
}

// Collation reports datcollate/datctype for a database — what proves a cluster created
// here matches one created by the postgres:16 image.
func (s *Supervisor) Collation(ctx context.Context, database string) (collate, ctype string, err error) {
	spec := s.plan.PsqlCommand("postgres",
		fmt.Sprintf("select datcollate || '|' || datctype from pg_database where datname = %s", quoteLiteral(database)))
	out, err := s.runOneShot(ctx, spec, time.Minute)
	if err != nil {
		return "", "", fmt.Errorf("read the collation of %s: %w\n%s", database, err, tail(out, 10))
	}
	collate, ctype, found := strings.Cut(strings.TrimSpace(out), "|")
	if !found {
		return "", "", fmt.Errorf("unexpected collation output for %s: %q", database, out)
	}
	return collate, ctype, nil
}

// SameLocale compares two locale spellings the way Postgres means them: en_US.UTF-8 and
// en_US.utf8 are the same locale written two ways.
func SameLocale(a, b string) bool {
	return normalizeLocale(a) == normalizeLocale(b)
}

func normalizeLocale(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer("-", "", "_", "", ".", "").Replace(s)
}

// runOneShot runs a command to completion and returns its combined output.
func (s *Supervisor) runOneShot(ctx context.Context, spec services.Spec, timeout time.Duration) (string, error) {
	return s.runOneShotStdin(ctx, spec, nil, timeout)
}

// runOneShotStdin is runOneShot with a script on stdin — how a plain SQL dump is fed to
// psql without ever materialising the decompressed file on disk. A household's dump
// expands to many times its compressed size, and writing that out only to read it back
// would need the space and leave a copy of the whole database in a temp directory.
func (s *Supervisor) runOneShotStdin(ctx context.Context, spec services.Spec, stdin io.Reader, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, spec.Path)
	cmd.Args = spec.Args
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.Stdin = stdin
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func appendFile(path, body string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.WriteString(body); err != nil {
		return fmt.Errorf("append to %s: %w", path, err)
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// quoteIdent and quoteLiteral keep generated SQL safe. The values are ours (a database
// name from config.env), but an operator can edit that file by hand.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func quoteLiteral(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}

func tail(out string, lines int) string {
	trimmed := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(trimmed) > lines {
		trimmed = trimmed[len(trimmed)-lines:]
	}
	return strings.Join(trimmed, "\n")
}
