package supervisor

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// How long the dump and restore tools get. A household database is small — a few tens of
// megabytes with photos kept outside it in media/ — but a Mac that has just woken up and
// is indexing can be slow, so these are generous rather than tight.
const (
	dumpTimeout    = 30 * time.Minute
	restoreTimeout = 60 * time.Minute
)

// BackupOptions configure one run.
type BackupOptions struct {
	// Out overrides the generated path. Retention is then skipped: a file the operator
	// named is theirs, and pruning a directory they chose would be a surprise.
	Out string
	// Keep is how many routine dumps to retain. Zero means what the nightly schedule
	// keeps, or the default when there is none — see retention.
	Keep int
}

// Backup takes a pg_dump of the application database.
//
// PowerSync's own storage database is deliberately NOT dumped, exactly as the Compose
// path leaves it alone: it holds derived bucket data, and restoring it alongside an older
// application database would leave the two disagreeing. It is rebuilt from the restored
// data instead, which is what `Restore` arranges.
//
// The dump is written under a temporary name and renamed on success. A dump is the one
// file that only matters when something has already gone wrong, so a half-written one
// left behind by a crash or a full disk must never be mistaken for a usable backup.
func (s *Supervisor) Backup(ctx context.Context, opts BackupOptions) (path string, err error) {
	started := time.Now()
	dir := s.plan.Layout.Backups
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}

	// One backup at a time, machine-wide. Taken BEFORE the failure is recorded below, so
	// a run that only ever waited is not written down as a backup that failed — the
	// nightly job meeting a "Back up now" click would otherwise turn System Health red
	// for no reason.
	release, err := s.lockBackups(ctx, dir)
	if err != nil {
		return "", err
	}
	defer release()

	// The name is chosen under the lock, so two runs that queued up cannot both land on
	// the same second-resolution filename. The same instant goes in the sidecar; `started`
	// stays the pre-lock one, because how long the backup took includes the waiting.
	takenAt := time.Now()
	out := opts.Out
	generated := out == ""
	if generated {
		out = filepath.Join(dir, backup.DumpName(takenAt))
	} else if abs, aerr := filepath.Abs(out); aerr == nil {
		out = abs
	}

	// Retention runs whichever way this ends, so it is deferred rather than done after a
	// dump has landed.
	//
	// The failure that decides it is a full disk: pg_dump fails on ENOSPC, and if pruning
	// only ever follows a successful dump, the one mechanism here that frees space is
	// never reached — so the next night fails identically, for good. Honouring `keep` is
	// the contract either way, and it is not a contract that deletes a good backup to
	// make room for one that does not exist: Prune removes only what is beyond `keep`, so
	// a failed run in a directory holding `keep` or fewer dumps removes nothing at all.
	if generated {
		defer func() {
			keep := opts.Keep
			if keep <= 0 {
				keep = s.retention()
			}
			removed, perr := backup.Prune(dir, backup.KindDump, keep)
			if perr != nil {
				s.log.Warnf("could not apply backup retention: %v", perr)
			}
			for _, r := range removed {
				s.log.Infof("pruned %s (keeping the last %d)", filepath.Base(r), keep)
			}
		}()
	}

	// Whatever went wrong is recorded where `status` and `doctor` will find it: a failed
	// backup leaves no file behind, so without this a week of broken nightly runs looks
	// exactly like a week of quiet success.
	defer func() {
		if err == nil {
			return
		}
		if rerr := backup.RecordFailure(dir, time.Now(), err.Error()); rerr != nil {
			s.log.Warnf("could not record the backup failure: %v", rerr)
		}
	}()

	stop, err := s.ensurePostgres(ctx)
	if err != nil {
		return "", err
	}
	defer stop()

	db := s.plan.Env.PostgresDB()
	runID := s.openBackupRun(ctx, db)

	if err := s.dumpTo(ctx, db, out); err != nil {
		s.closeBackupRun(ctx, db, runID, "", 0, started, err)
		return "", err
	}

	size := fileSize(out)
	if generated {
		s.writeSidecar(ctx, out, db, size, takenAt, crossing{})
	}
	s.closeBackupRun(ctx, db, runID, filepath.Base(out), size, started, nil)

	if err := backup.ClearFailure(dir); err != nil {
		s.log.Warnf("could not clear the recorded backup failure: %v", err)
	}

	s.log.Infof("backed up %s to %s (%.1f MB in %s)", db, out,
		float64(size)/(1<<20), time.Since(started).Round(100*time.Millisecond))
	return out, nil
}

// lockBackups takes the exclusive, machine-wide backup lock and returns the function
// that gives it back.
//
// Two backups can genuinely coincide: the 03:00 launchd job and a "Back up now" click,
// or two Macs' worth of habits in one household. Dump names are second-resolution, so
// two runs in the same second computed the same file and the same `.part` beside it —
// one would unlink the other's in-progress dump, and whichever renamed first could
// promote a half-written file to the canonical backup name while `status` and `doctor`
// reported it as healthy and current. A backup that is quietly truncated is worse than
// no backup, because it is believed.
//
// flock, not a pidfile: it is held by the open file description, so the kernel releases
// it if the process is killed — a lock that outlived a crash would need someone to
// notice and delete it, at 03:00, on a Mac nobody is sitting at. The second run WAITS
// rather than failing: it then takes its own dump a moment later, where a clean refusal
// would have to be recorded as a failed nightly backup and shown as one.
func (s *Supervisor) lockBackups(ctx context.Context, dir string) (func(), error) {
	path := filepath.Join(dir, ".lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open the backup lock %s: %w", path, err)
	}
	announced := false
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				// Closing releases it too; unlocking first keeps the pair explicit.
				_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
				_ = f.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
		if !announced {
			s.log.Infof("another backup is already running; waiting for it to finish")
			announced = true
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, fmt.Errorf("waiting for the backup already in progress: %w", ctx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// dumpTo writes the dump under a temporary name and renames it into place.
func (s *Supervisor) dumpTo(ctx context.Context, db, out string) error {
	tmp := out + ".part"
	_ = os.Remove(tmp)
	if dumpOut, err := s.runOneShot(ctx, s.plan.PgDump(db, tmp), dumpTimeout); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("pg_dump failed: %w\n%s", err, tail(dumpOut, 20))
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		s.log.Warnf("could not tighten permissions on the dump: %v", err)
	}
	if err := os.Rename(tmp, out); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("finish writing %s: %w", out, err)
	}
	return nil
}

// crossing is the version change a pre-migrate snapshot is taken for: the build that
// wrote the data, and the build about to change its schema. A routine backup marks no
// crossing and passes the zero value.
type crossing struct{ from, to string }

// writeSidecar records what the dump is, beside it. Best-effort: a dump with no sidecar
// still restores, it just has to be unpacked to learn its level.
func (s *Supervisor) writeSidecar(ctx context.Context, out, db string, size int64, at time.Time, cross crossing) {
	side := backup.Sidecar{
		Database:    db,
		SizeBytes:   size,
		TakenAt:     at.UTC().Format(time.RFC3339),
		FromVersion: cross.from,
		ToVersion:   cross.to,
	}
	if m := s.manifest; m != nil {
		side.WaffledVersion, side.GitSha = m.WaffledVersion, m.GitSha
	}
	if names, err := s.appliedMigrations(ctx, db); err == nil {
		side.Migration = backup.Level(names)
	}
	if collate, _, err := s.Collation(ctx, db); err == nil {
		side.Collation = collate
	}
	if err := backup.WriteSidecar(out, side); err != nil {
		s.log.Warnf("could not write the backup metadata: %v", err)
	}
}

// ensurePostgres makes Postgres reachable and returns the function that undoes whatever
// it had to do.
//
// The design decision behind it: `backup` works with the stack stopped by starting
// Postgres alone, temporarily, and shutting it down again afterwards. The alternative —
// refusing unless the server is up — would make the 03:00 launchd job silently useless
// on exactly the Macs it matters on, because a login item only runs the server while
// someone is signed in and nobody stays signed in to a Mac they left. Postgres alone is
// cheap (about two seconds), touches nothing but its own socket, and leaves the machine
// as it found it.
func (s *Supervisor) ensurePostgres(ctx context.Context) (func(), error) {
	noop := func() {}
	if err := s.requireCluster(); err != nil {
		return noop, err
	}
	if _, running := s.postgresPid(); running {
		return noop, nil
	}

	s.log.Infof("the server is stopped; starting postgres alone for this operation")
	if err := s.reconcilePostgresConf(); err != nil {
		return noop, err
	}
	if err := s.startPostgres(ctx); err != nil {
		return noop, err
	}
	return func() {
		// Its own deadline: the caller's context may already be cancelled or expired,
		// and leaving a postmaster behind would collide with the next real start.
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pgStopTimeout)
		defer cancel()
		if err := s.stopPostgres(stopCtx); err != nil {
			s.log.Warnf("could not stop the temporary postgres: %v", err)
		}
	}, nil
}

// requireCluster refuses the operations that need a database to already be there. One
// source for the message, because `restore` asks the question without starting a server
// while `backup` asks it on the way to starting one.
func (s *Supervisor) requireCluster() error {
	if s.postgresInitialized() {
		return nil
	}
	return fmt.Errorf(
		"there is no database in %s yet — run `waffled-runtime start` once first",
		s.plan.Layout.Postgres)
}

// ── backup_runs ─────────────────────────────────────────────────────────────────────
//
// The same rows the Compose backup sidecar writes, so `/api/health` and Settings →
// System Health keep reporting on backups natively. Column semantics are copied from
// infra/compose/backup/backup.sh: a 'running' row on the way in, updated to 'success' or
// 'failed' on the way out.
//
// Every write here is best-effort, exactly as the sidecar's are. A backup that succeeded
// but could not be announced is still a backup; failing the command over the bookkeeping
// would turn a healthy nightly run into a broken one.
//
// Note what is deliberately NOT written: a row for a restore. The table has a `kind`
// column, but the api reads `where status in ('success','failed') order by finished_at
// desc limit 1` with no filter on it — so a restore row would be picked up as "the last
// backup", and a household that restored last week would be told its backups were
// current. Restores are narrated in the runtime log instead.

func (s *Supervisor) openBackupRun(ctx context.Context, db string) string {
	// Wrapped in a CTE so the statement is a SELECT. A bare `insert … returning id`
	// through `psql -tAc` prints the returned value AND psql's own "INSERT 0 1" command
	// tag on the next line, and the two together are not a uuid — every later update
	// then failed on a malformed id and the row stayed 'running' forever, which the api
	// ignores. So the backup succeeded and System Health showed nothing at all.
	id, err := s.QueryScalar(ctx, db,
		"with started as ("+
			"insert into backup_runs (status, kind, destination) "+
			"values ('running','database','local') returning id"+
			") select id from started")
	if err != nil {
		// Expected before migration 0071, and on any install whose api is older.
		s.log.Warnf("could not record the start of this backup (System Health will not show it): %v", err)
		return ""
	}
	return strings.TrimSpace(id)
}

func (s *Supervisor) closeBackupRun(ctx context.Context, db, id, file string, size int64, started time.Time, failure error) {
	if id == "" {
		return
	}
	ms := time.Since(started).Milliseconds()
	var sql string
	if failure != nil {
		sql = fmt.Sprintf(
			"update backup_runs set status='failed', finished_at=now(), error=%s, duration_ms=%d where id=%s",
			quoteLiteral(truncate(failure.Error(), 2000)), ms, quoteLiteral(id))
	} else {
		sql = fmt.Sprintf(
			"update backup_runs set status='success', finished_at=now(), file_name=%s, "+
				"size_bytes=%d, duration_ms=%d where id=%s",
			quoteLiteral(file), size, ms, quoteLiteral(id))
	}
	// Its own context: on the failure path the caller's may already be done.
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	if _, err := s.QueryScalar(runCtx, db, sql); err != nil {
		s.log.Warnf("could not record the outcome of this backup: %v", err)
	}
}

// ── migration levels ────────────────────────────────────────────────────────────────

// appliedMigrations lists what the database has run, by name.
func (s *Supervisor) appliedMigrations(ctx context.Context, db string) ([]string, error) {
	// to_regclass answers without raising, so a database from before the migrations
	// table existed reports "no migrations" rather than an error.
	exists, err := s.QueryScalar(ctx, db, "select to_regclass('public."+backup.MigrationsTable+"') is not null")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(exists) != "t" {
		return nil, nil
	}
	out, err := s.QueryScalar(ctx, db, "select name from "+backup.MigrationsTable+" order by name")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// bundleMigrations lists what this build ships.
func (s *Supervisor) bundleMigrations() ([]string, error) {
	return backup.MigrationNamesInDir(backup.MigrationsDir(s.plan.Bundle, s.migrationsFromManifest()))
}

// dumpMigrationLevel reads a dump's schema level: from the sidecar when there is one,
// and otherwise out of the dump itself.
//
// The fallback is not optional. The dump that most needs checking is one carried over
// from a Docker install, which will never have a sidecar — that is precisely the file
// someone restores onto a Mac whose bundle may be older than the server they left.
func (s *Supervisor) dumpMigrationLevel(ctx context.Context, file string) (string, error) {
	if side, ok := backup.ReadSidecar(file); ok && side.Migration != "" {
		return side.Migration, nil
	}
	switch backup.FormatOf(file) {
	case backup.FormatCustom:
		out, err := s.runOneShot(ctx, s.plan.PgRestoreTable(file, backup.MigrationsTable), 5*time.Minute)
		if err != nil {
			return "", fmt.Errorf("read the migration level out of %s: %w\n%s", file, err, tail(out, 10))
		}
		names, err := backup.MigrationNamesFrom(strings.NewReader(out))
		if err != nil {
			return "", err
		}
		return backup.Level(names), nil
	case backup.FormatPlain, backup.FormatPlainGzip:
		f, err := os.Open(file)
		if err != nil {
			return "", err
		}
		defer f.Close()
		var r io.Reader = f
		if backup.FormatOf(file) == backup.FormatPlainGzip {
			gz, err := gzip.NewReader(f)
			if err != nil {
				return "", fmt.Errorf("%s is not a valid gzip file: %w", file, err)
			}
			defer gz.Close()
			r = gz
		}
		names, err := backup.MigrationNamesFrom(r)
		if err != nil {
			return "", err
		}
		return backup.Level(names), nil
	default:
		return "", fmt.Errorf("%s is not a dump this can read", file)
	}
}

// ── the downgrade guard ─────────────────────────────────────────────────────────────

// checkNotDowngraded refuses to serve data that a NEWER build has already migrated.
//
// It is the other half of the rollback story. `start` protects the data going forward —
// snapshot, migrate, health gate, restore on failure — but the person recovering
// availability re-installs the previous DMG, and that older bundle then meets a database
// it cannot serve: either because the update succeeded and they changed their mind, or
// because it failed somewhere the automatic restore could not reach. Migrations only run
// forward, so there is no way down; the api would come up against tables and columns its
// code does not know about, and the damage from that is silent.
//
// It deliberately does NOT restore anything. The newest snapshot is named in the message
// and left alone: everything the newer version wrote since then is still on disk, and
// restoring is the one action here that would throw it away. That choice belongs to the
// person, not to a guard running at startup on a Mac nobody is sitting at.
//
// Called after Postgres is up and before migrate, which is the only window where the
// question can be asked and the answer still costs nothing.
func (s *Supervisor) checkNotDowngraded(ctx context.Context) error {
	db := s.plan.Env.PostgresDB()
	applied, err := s.appliedMigrations(ctx, db)
	if err != nil {
		return fmt.Errorf("check which migrations this database has applied: %w", err)
	}
	if len(applied) == 0 {
		return nil // a database with no migrations cannot be ahead of anything
	}
	bundled, err := s.bundleMigrations()
	if err != nil {
		return err
	}
	if len(bundled) == 0 {
		// Not a downgrade — a broken bundle. Reporting it as "the data is newer" would
		// send someone chasing a version that was never installed.
		return fmt.Errorf("this build ships no migrations in %s, so it cannot be checked against "+
			"the database — the bundle is incomplete",
			backup.MigrationsDir(s.plan.Bundle, s.migrationsFromManifest()))
	}
	unshipped := backup.Unshipped(bundled, applied)
	if len(unshipped) == 0 {
		return nil
	}

	d := &backup.Downgrade{
		LastVersion: s.startedVersion,
		ThisVersion: s.bundleVersion(),
		Unshipped:   unshipped,
		BundleLevel: backup.Level(bundled),
		BackupsDir:  s.plan.Layout.Backups,
	}
	if path, side, ok := backup.NewestRestorable(s.plan.Layout.Backups, d.BundleLevel); ok {
		d.Snapshot, d.SnapshotAt = path, side.TakenAt
	}
	return d
}

// migrationsFromManifest is the manifest's migrations path, or "" for the default.
func (s *Supervisor) migrationsFromManifest() string {
	if s.manifest == nil {
		return ""
	}
	return s.manifest.Components.API.Migrations
}

// ── pre-migration snapshot and rollback ─────────────────────────────────────────────

// snapshotBeforeMigrate takes a rollback point when, and only when, migrations are
// actually pending. It returns the file it wrote, or "" when nothing was needed.
//
// A first run takes none: there is nothing yet to lose, and dumping an empty database to
// protect it would only be theatre.
func (s *Supervisor) snapshotBeforeMigrate(ctx context.Context) (string, error) {
	db := s.plan.Env.PostgresDB()
	applied, err := s.appliedMigrations(ctx, db)
	if err != nil {
		return "", fmt.Errorf("check which migrations this database has applied: %w", err)
	}
	if len(applied) == 0 {
		return "", nil // first run: an empty database, nothing to roll back to
	}
	bundled, err := s.bundleMigrations()
	if err != nil {
		return "", err
	}
	pending := backup.Pending(bundled, applied)
	if len(pending) == 0 {
		return "", nil
	}

	// The crossing this snapshot marks. `to` is the running build; `from` is whatever
	// runtime.json remembered when this Supervisor was constructed, which is "" — named
	// "unknown" — on data written before that was recorded. They are equal when a start
	// re-runs a migration under the same build, and that is a fact worth showing rather
	// than hiding: the snapshot still marks a schema change.
	cross := crossing{from: s.startedVersion, to: s.bundleVersion()}
	if err := os.MkdirAll(s.plan.Layout.Backups, 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", s.plan.Layout.Backups, err)
	}
	out := filepath.Join(s.plan.Layout.Backups, backup.SnapshotName(cross.from, cross.to, time.Now()))

	s.log.Infof("%d migration(s) pending (%s…); taking a rollback snapshot first",
		len(pending), pending[0])
	if err := s.dumpTo(ctx, db, out); err != nil {
		// Deliberately fatal, matching run_pre_upgrade_backup in the repo-root `waffled`
		// script. This only happens on a start that is about to change the schema, and
		// going through that with no way back is the one risk worth refusing to start
		// over — the alternative is discovering the problem after the data is gone.
		return "", fmt.Errorf("could not take a pre-migration snapshot, so the schema change "+
			"has been stopped rather than run without a way back: %w", err)
	}
	s.writeSidecar(ctx, out, db, fileSize(out), time.Now(), cross)

	removed, perr := backup.Prune(s.plan.Layout.Backups, backup.KindSnapshot, backup.DefaultKeepSnapshots)
	if perr != nil {
		s.log.Warnf("could not prune old snapshots: %v", perr)
	}
	for _, r := range removed {
		s.log.Infof("pruned old snapshot %s", filepath.Base(r))
	}
	s.log.Infof("rollback snapshot: %s", out)
	return out, nil
}

// rollbackTo restores a snapshot after a migration left the api unable to start.
//
// It clears the database's writers first, in reverse dependency order. The api may be
// running but failing its health check, and restoring under a live connection pool would
// fight it for the database.
//
// PowerSync is stopped too, and it is not a formality. On this path it is normally not
// running — the start sequence reaches it only after the api's health gate, the gate
// whose failure brought us here — but a PowerSync left behind by a supervisor that died
// IS running, holding an active logical replication slot, and startChild's orphan reap is
// downstream of the gate so it never fires in time. An active slot cannot be dropped, and
// a rollback that cannot drop it leaves the household on the migrated schema their build
// cannot serve, holding an unused snapshot. Killing the process first also stops it
// racing us: terminating its backend while it is alive only has it reconnect and take the
// slot again.
func (s *Supervisor) rollbackTo(ctx context.Context, snapshot string) error {
	s.log.Warnf("the api did not come up after migrating; rolling back to %s", snapshot)

	s.stopService(services.PowerSync)
	s.stopService(services.API)

	if err := s.replaceDatabase(ctx, snapshot); err != nil {
		return err
	}
	s.log.Infof("rolled back to %s", snapshot)
	return nil
}

// stopService stops one service whether this process started it or a previous one did.
// The two cases look different — a child we hold, versus a pid in a pidfile — and the
// caller of a rollback cannot know which it has.
func (s *Supervisor) stopService(name string) {
	s.mu.Lock()
	c := s.children[name]
	s.mu.Unlock()
	if c != nil {
		if err := c.stop(stopGrace); err != nil {
			s.log.Warnf("could not stop %s before rolling back: %v", name, err)
		}
		s.mu.Lock()
		delete(s.children, name)
		s.mu.Unlock()
		return
	}
	if s.serviceRunning(name) {
		s.log.Infof("stopping %s (started by a previous run)", name)
		_ = s.stopOrphan(name)
	}
}

// ── restore ─────────────────────────────────────────────────────────────────────────

// RestoreOptions configure a restore.
type RestoreOptions struct {
	// File is the dump to restore.
	File string
	// Yes skips the typed confirmation. Without it, and without a terminal to ask on,
	// the restore refuses: this is the one command that destroys data outright.
	Yes bool
	// Confirm is asked when there is a terminal. Nil means "no terminal".
	Confirm func(prompt string) bool
}

// Restore replaces the application database with a dump and leaves Postgres running.
//
// It stops the whole stack rather than only the three app services the Compose path
// stops. Natively there is a supervisor process holding the children, and restart
// supervision is armed once a service has been healthy — so signalling the api directly
// would simply have it brought straight back mid-restore, by our own code. Stopping the
// supervisor is the only way to make "nothing writes during the restore" true.
//
// It returns with the stack fully stopped. The caller starts it again — detached from
// the CLI, in-process from a test — so the restart is owned by a process that will
// outlive the command, and so the migrations that catch up an older dump and the
// rebuilding of PowerSync's storage happen through the ordinary start sequence rather
// than a second copy of it here.
func (s *Supervisor) Restore(ctx context.Context, opts RestoreOptions) error {
	file, err := filepath.Abs(opts.File)
	if err != nil {
		return err
	}
	if _, err := os.Stat(file); err != nil {
		return fmt.Errorf("%s: %w", opts.File, err)
	}
	if format := backup.FormatOf(file); format == backup.FormatUnknown {
		return fmt.Errorf("%s does not look like a database dump — expected a .dump from this "+
			"runtime, or a .sql/.sql.gz from a Docker install", file)
	}

	// Check what this is BEFORE stopping anything: a household should not lose its
	// running server to a restore that was never going to be allowed.
	//
	// None of it touches a server. The dump's level comes from its sidecar, or from
	// `pg_restore --file -`, which reads the file and connects to nothing; the bundle's
	// level is a directory listing. So no postmaster is started for this — one that was
	// down stays down until the restore proper needs it, below.
	if err := s.requireCluster(); err != nil {
		return err
	}
	level, lerr := s.dumpMigrationLevel(ctx, file)
	if lerr != nil {
		s.log.Warnf("could not read the migration level of %s (%v); restoring anyway", file, lerr)
	}
	bundled, err := s.bundleMigrations()
	if err != nil {
		return err
	}
	if err := backup.CheckRestorable(level, backup.Level(bundled)); err != nil {
		return err
	}
	if level == "" {
		s.log.Warnf("could not tell which migration %s was taken at; if it came from a newer "+
			"Waffled than this one, the restore may leave the database ahead of the code", file)
	}

	if !opts.Yes {
		if opts.Confirm == nil {
			return errors.New("restoring OVERWRITES the current database and cannot be undone. " +
				"Re-run with --yes to confirm, or run it in a terminal")
		}
		if !opts.Confirm(fmt.Sprintf(
			"This REPLACES everything in %s with %s.\nAll current data is lost.\nType 'restore' to continue: ",
			s.plan.Env.PostgresDB(), filepath.Base(file))) {
			return errors.New("aborted")
		}
	}

	s.log.Infof("stopping the server so nothing writes during the restore")
	stopCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	err = s.StopDetached(stopCtx, 2*time.Minute)
	cancel()
	if err != nil {
		return fmt.Errorf("could not stop the server before restoring: %w", err)
	}

	pgStop, err := s.ensurePostgres(ctx)
	if err != nil {
		return err
	}
	// Postgres was started for the restore alone, so it is stopped again whatever
	// happens. Leaving a bare postmaster listening with no supervisor — on the success
	// path OR on a failure part-way through replacing the database — would collide with
	// the start that follows and, after a failure, leave something running that nobody
	// asked for. `Start` brings Postgres back up itself and is idempotent, so handing the
	// caller a fully stopped stack costs a second and leaks nothing.
	defer pgStop()

	if err := s.replaceDatabase(ctx, file); err != nil {
		return err
	}
	s.log.Infof("restored %s from %s", s.plan.Env.PostgresDB(), file)
	return nil
}

// replaceDatabase is the destructive middle of both restore and rollback: drop the
// application database, recreate it, and load the dump into the empty result.
//
// Dropping rather than restoring over the top with --clean is deliberate. A restore is
// meant to produce exactly what the dump holds; --clean leaves behind anything the dump
// does not mention, and its DROP ordering has to be right for every object type. An empty
// database has no such questions.
func (s *Supervisor) replaceDatabase(ctx context.Context, file string) error {
	db := s.plan.Env.PostgresDB()

	// PowerSync's logical replication slot pins the database and blocks the drop, so it
	// goes first. This is also the native half of what Compose gets for free: the slot
	// must be gone for PowerSync to rebuild its buckets from the restored data rather
	// than resuming from a WAL position that no longer describes this database.
	if err := s.dropReplicationSlots(ctx, db); err != nil {
		return err
	}
	// PowerSync's bucket storage describes the OLD data. Dropped here and recreated by
	// 00-init.sql on the next start, which initDatabases runs every time.
	if err := s.dropDatabase(ctx, services.StorageDatabase); err != nil {
		return err
	}

	if err := s.dropDatabase(ctx, db); err != nil {
		return err
	}
	if out, err := s.runOneShot(ctx,
		s.plan.PsqlCommand("postgres", "create database "+quoteIdent(db)), time.Minute); err != nil {
		return fmt.Errorf("recreate the %s database: %w\n%s", db, err, tail(out, 10))
	}

	s.log.Infof("loading %s", filepath.Base(file))
	switch backup.FormatOf(file) {
	case backup.FormatCustom:
		if out, err := s.runOneShot(ctx, s.plan.PgRestore(db, file), restoreTimeout); err != nil {
			return fmt.Errorf("pg_restore failed: %w\n%s", err, tail(out, 30))
		}
	default:
		if err := s.restorePlain(ctx, db, file); err != nil {
			return err
		}
	}
	return nil
}

// restorePlain pipes a plain (or gzipped) SQL dump into psql — the format the Compose
// backup sidecar writes, and so the path a household moving off Docker takes.
func (s *Supervisor) restorePlain(ctx context.Context, db, file string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()

	var r io.Reader = f
	if backup.FormatOf(file) == backup.FormatPlainGzip {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return fmt.Errorf("%s is not a valid gzip file: %w", file, err)
		}
		defer gz.Close()
		r = gz
	}
	out, err := s.runOneShotStdin(ctx, s.plan.PsqlStdin(db), r, restoreTimeout)
	if err != nil {
		return fmt.Errorf("restoring %s failed: %w\n%s", filepath.Base(file), err, tail(out, 30))
	}
	return nil
}

// dropReplicationSlots removes every logical slot on a database.
func (s *Supervisor) dropReplicationSlots(ctx context.Context, db string) error {
	out, err := s.QueryScalar(ctx, "postgres",
		"select slot_name from pg_replication_slots where database = "+quoteLiteral(db))
	if err != nil {
		return fmt.Errorf("list the replication slots: %w", err)
	}
	for _, name := range strings.Split(out, "\n") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		s.log.Infof("dropping replication slot %s so PowerSync rebuilds from the restored data", name)
		if err := s.dropReplicationSlot(ctx, name); err != nil {
			return err
		}
	}
	return nil
}

// dropReplicationSlot disconnects whatever still holds one slot and drops it, retrying
// while the walsender lets go.
//
// pg_drop_replication_slot refuses an ACTIVE slot outright, and the caller cannot assume
// there is nobody on it: a PowerSync orphaned by a supervisor that died is still
// streaming. The callers stop that process first, but stopping it is asynchronous —
// pg_terminate_backend only asks a backend to exit and returns before it has, exactly as
// dropDatabase below documents for DROP DATABASE, so the same shape applies. Anything
// that is not the slot being busy fails at once; retrying it would not help.
func (s *Supervisor) dropReplicationSlot(ctx context.Context, name string) error {
	const attempts = 20
	var lastOut string
	var lastErr error
	for i := 0; i < attempts; i++ {
		// Re-asked every time: a walsender can reconnect between the terminate and the
		// drop, which is the normal case while a process is still shutting down.
		if _, err := s.QueryScalar(ctx, "postgres",
			"select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = "+
				quoteLiteral(name)+" and active"); err != nil {
			s.log.Warnf("could not disconnect the holder of the replication slot %s: %v", name, err)
		}
		out, err := s.runOneShot(ctx,
			s.plan.PsqlCommand("postgres", "select pg_drop_replication_slot("+quoteLiteral(name)+")"),
			time.Minute)
		if err == nil {
			return nil
		}
		lastOut, lastErr = out, err
		// Someone else dropped it — a restore racing a rollback, or PowerSync tidying up
		// on its way out. The slot is gone, which is all this asked for.
		if strings.Contains(out, "does not exist") {
			return nil
		}
		if !strings.Contains(out, "is active") {
			break // a different failure; retrying will not help
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fmt.Errorf("drop the replication slot %s: %w\n%s", name, lastErr, tail(lastOut, 10))
}

// dropDatabase terminates whatever is still connected and drops it, retrying while
// clients are still letting go.
//
// pg_terminate_backend only ASKS a backend to exit; it returns before the backend has
// finished doing so, and DROP DATABASE fails outright with "is being accessed by other
// users" if it arrives in that window. A service the supervisor has just SIGTERMed is
// exactly such a backend, so the race is the normal case rather than an unlucky one, and
// losing the race would abort a restore the user had already confirmed.
func (s *Supervisor) dropDatabase(ctx context.Context, name string) error {
	const attempts = 20
	var lastOut string
	var lastErr error
	for i := 0; i < attempts; i++ {
		// Re-asked every time: a client can reconnect between the terminate and the drop.
		if _, err := s.QueryScalar(ctx, "postgres",
			"select pg_terminate_backend(pid) from pg_stat_activity where datname = "+
				quoteLiteral(name)+" and pid <> pg_backend_pid()"); err != nil {
			s.log.Warnf("could not disconnect existing clients of %s: %v", name, err)
		}
		out, err := s.runOneShot(ctx,
			s.plan.PsqlCommand("postgres", "drop database if exists "+quoteIdent(name)),
			2*time.Minute)
		if err == nil {
			return nil
		}
		lastOut, lastErr = out, err
		if !strings.Contains(out, "is being accessed by other users") {
			break // a different failure; retrying will not help
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fmt.Errorf("drop the %s database: %w\n%s", name, lastErr, tail(lastOut, 10))
}

func fileSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
