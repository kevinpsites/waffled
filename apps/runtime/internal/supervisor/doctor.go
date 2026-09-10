package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
	"github.com/kevinpsites/waffled/apps/runtime/internal/schedule"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// Check is one diagnostic result.
type Check struct {
	Name   string `json:"name"`
	Status string `json:"status"` // ok | warn | fail
	Detail string `json:"detail"`
}

// Check statuses.
const (
	CheckOK   = "ok"
	CheckWarn = "warn"
	CheckFail = "fail"
)

// CheckBundleManifest names the check that reports the bundle's manifest verification.
// `doctor --json` emits these names, and apps/mac/Scripts/build-app.sh selects this one
// out of the array to gate assembling the app — so the string is a contract with a
// script, not a label. Change it here and change it there.
const CheckBundleManifest = "bundle manifest"

// minFreeDisk is roughly what a household needs before disk space becomes the problem:
// the bundle is already on disk, so this is headroom for the database, media and dumps.
const minFreeDisk = 5 << 30 // 5 GiB

// Doctor answers "why isn't this working" without needing the stack to be up. It is the
// thing support asks someone to run and paste.
func (s *Supervisor) Doctor(ctx context.Context) []Check {
	var checks []Check
	add := func(name, status, format string, args ...any) {
		checks = append(checks, Check{Name: name, Status: status, Detail: fmt.Sprintf(format, args...)})
	}

	// The bundle was already verified in New(), or we would not be here.
	if m := s.manifest; m != nil {
		add(CheckBundleManifest, CheckOK, "%d files + %d symlinks verified — %s",
			m.FileCount, m.SymlinkCount, m.VersionSummary())
	}

	if err := writableCheck(s.plan.Layout.Root); err != nil {
		add("data directory", CheckFail, "%s is not writable: %v", s.plan.Layout.Root, err)
	} else {
		add("data directory", CheckOK, "%s", s.plan.Layout.Root)
	}

	// config.env holds every secret; loose permissions on a shared Mac matter.
	if st, err := os.Stat(s.plan.Layout.ConfigEnv); err == nil {
		if perm := st.Mode().Perm(); perm&0o077 != 0 {
			add("config.env permissions", CheckWarn,
				"%s is %o — it holds every secret and should be 0600", s.plan.Layout.ConfigEnv, perm)
		} else {
			add("config.env permissions", CheckOK, "0600")
		}
	}

	for _, warning := range s.plan.Layout.Risks() {
		add("data directory location", CheckWarn, "%s", warning)
	}

	if isExcludedFromBackup(s.plan.Layout.Postgres) {
		add("Time Machine", CheckOK, "the live database is excluded; %s is what gets backed up", s.plan.Layout.Backups)
	} else if s.postgresInitialized() {
		add("Time Machine", CheckWarn,
			"%s is NOT excluded from Time Machine — restoring a live cluster from a file-level backup corrupts it",
			s.plan.Layout.Postgres)
	}

	// Backups: the one check whose answer someone only ever wants once it is too late.
	b := backup.Describe(s.plan.Layout.Backups, s.scheduleInstalled(), s.scheduleAt())
	switch {
	case b.LastError != "":
		add("backups", CheckFail, "the last backup failed (%s): %s", b.LastErrorAt, b.LastError)
	case b.LastBackupAt == "":
		add("backups", CheckWarn, "no backup has been taken yet — run `waffled-runtime backup`, "+
			"or `waffled-runtime backup --install-schedule` for a nightly one")
	default:
		age := ""
		if at, err := time.Parse(time.RFC3339, b.LastBackupAt); err == nil {
			age = fmt.Sprintf(" (%s ago)", time.Since(at).Round(time.Hour))
		}
		// The api's own health check calls a backup stale after 48 hours; matching it
		// means `doctor` and System Health never disagree about the same fact.
		if at, err := time.Parse(time.RFC3339, b.LastBackupAt); err == nil && time.Since(at) > 48*time.Hour {
			add("backups", CheckWarn, "the last backup was %s%s — %d kept in %s",
				b.LastBackupAt, age, b.Count, s.plan.Layout.Backups)
		} else {
			add("backups", CheckOK, "last backup %s%s, %.1f MB — %d kept in %s",
				b.LastBackupAt, age, float64(b.LastSizeBytes)/(1<<20), b.Count, s.plan.Layout.Backups)
		}
	}
	// The plist on disk is only half the answer, and `status` stops at that half because
	// it polls. Here — once, when a human asks — launchd is asked whether it actually
	// holds the job: a bootstrap that failed on an older build, or a label booted out by
	// hand, leaves a file that every other reporter reads as "installed" while no backup
	// will ever run.
	switch {
	case !b.ScheduleInstalled:
		add("backup schedule", CheckWarn,
			"no nightly backup is scheduled — install one with `waffled-runtime backup --install-schedule`")
	default:
		if loaded, err := s.scheduleLoaded(); loaded {
			// The time comes from the plist launchd is holding, so "it is scheduled" and
			// "it runs then" are one answer rather than two that can drift.
			add("backup schedule", CheckOK, "a nightly backup is installed and loaded, at %s (%s)",
				b.ScheduleAt, schedule.Label)
		} else {
			add("backup schedule", CheckWarn,
				"%s is installed but launchd does not have the job loaded, so no backup will run — "+
					"re-run `waffled-runtime backup --install-schedule`: %v", schedule.Label, err)
		}
	}

	if free, err := freeDiskBytes(s.plan.Layout.Root); err != nil {
		add("disk space", CheckWarn, "could not measure free space: %v", err)
	} else if free < minFreeDisk {
		add("disk space", CheckWarn, "%.1f GB free on the volume holding the data directory", float64(free)/(1<<30))
	} else {
		add("disk space", CheckOK, "%.1f GB free", float64(free)/(1<<30))
	}

	// Ports: free is fine, held by our own service is fine, held by anything else is not.
	// The table is services.PortChecks — the same one settlePorts validates, so doctor
	// can never report a port free that start would refuse.
	for _, c := range s.plan.PortChecks() {
		switch {
		case s.ownsPort(c.Service):
			add("port "+c.Label, CheckOK, "%d — in use by our own %s", c.Port, c.Label)
		case ports.IsFree(c.Scope, c.Port):
			add("port "+c.Label, CheckOK, "%d is free", c.Port)
		default:
			holder := ports.DescribeHolder(c.Port)
			if holder == "" {
				holder = "another process"
			}
			add("port "+c.Label, CheckFail, "%d is held by %s", c.Port, holder)
		}
	}

	// Discovery: `status` can only report what this Mac asked for, so this is the one
	// place that asks the network whether the advertisement actually answers.
	checks = append(checks, s.bonjourCheck(ctx))

	if !s.postgresInitialized() {
		add("postgres", CheckWarn, "no database cluster yet — it is created on the first start")
		return checks
	}

	// Everything from here needs a reachable Postgres, so ONE postmaster is brought up to
	// serve all of it — started the way `backup` does when the stack is down, and put back
	// afterwards.
	//
	// That is not an optimisation. A bundle too old for the schema is refused by `start`,
	// so by the time anyone runs `doctor` to ask why, nothing is running — and the checks
	// below the old "postgres is up" gate were then skipped in exactly the case `doctor`
	// exists for, while the schema check above it paid for a start and stop of its own.
	// The command someone runs BECAUSE their server will not start answered fewer
	// questions than the one they run when it is fine.
	//
	// The pid is read FIRST: after ensurePostgres, "is postgres running?" would be
	// answered by the postmaster this function just started.
	pid, running := s.postgresPid()
	stop, err := s.ensurePostgres(ctx)
	if err != nil {
		// Nothing below can be asked, and each would otherwise fail separately with its
		// own version of the same news.
		add("postgres", CheckFail, "could not start postgres to run the database checks: %v", err)
		return checks
	}
	defer stop()

	if running {
		add("postgres", CheckOK, "running (pid %d) on 127.0.0.1:%d", pid, s.plan.Ports.Postgres)
	} else {
		// Not a fault on its own — `doctor` is most useful on a stopped install — but the
		// distinction has to survive, or the checks below would read as a running server.
		add("postgres", CheckWarn, "not running; started temporarily so the checks below could run")
	}

	// Whether this build may serve this data at all.
	checks = append(checks, s.schemaCheck(ctx))

	if _, err := s.runOneShot(ctx, s.plan.PgIsReady(), 10*time.Second); err != nil {
		add("postgres connection", CheckFail, "pg_isready failed: %v", err)
		return checks
	}
	add("postgres connection", CheckOK, "accepting connections")

	// wal_level=logical is what PowerSync replication needs; without it sync silently
	// never starts while every health check stays green.
	if out, err := s.runOneShot(ctx, s.plan.PsqlCommand("postgres", "show wal_level"), 15*time.Second); err != nil {
		add("wal_level", CheckWarn, "could not read wal_level: %v", err)
	} else if level := strings.TrimSpace(out); level != "logical" {
		add("wal_level", CheckFail, "wal_level is %q but PowerSync replication needs \"logical\"", level)
	} else {
		add("wal_level", CheckOK, "logical")
	}

	// The collation must match the postgres:16 image, or a dump restored from Docker
	// sorts differently and every index reports a collation-version mismatch.
	if collate, ctype, err := s.Collation(ctx, s.plan.Env.PostgresDB()); err != nil {
		add("collation", CheckWarn, "could not read the database collation: %v", err)
	} else if !SameLocale(collate, services.InitdbCollation) || !SameLocale(ctype, services.InitdbCollation) {
		add("collation", CheckWarn,
			"the database is %s/%s but this runtime creates clusters as %s — a dump moved between "+
				"a Docker install and this one may sort differently", collate, ctype, services.InitdbCollation)
	} else {
		add("collation", CheckOK, "%s (matches the Docker postgres:16 image)", collate)
	}

	return checks
}

// schemaCheck reports the database's migration level against this build's, and fails on
// the state `start` refuses: a schema holding migrations this bundle does not ship.
//
// It brings Postgres up if it has to and puts it back, so the answer is the same whether
// the server is running or not. Everything it reports is what `start` would have found.
//
// Doctor already holds a postmaster by the time it calls this, which makes the
// ensurePostgres below a no-op — it returns early when one is running. The call stays
// because it is what makes this check answerable on its own terms rather than only as
// something Doctor sets up for; nesting it costs a pid read.
func (s *Supervisor) schemaCheck(ctx context.Context) Check {
	check := func(status, format string, args ...any) Check {
		return Check{Name: "database schema", Status: status, Detail: fmt.Sprintf(format, args...)}
	}
	stop, err := s.ensurePostgres(ctx)
	if err != nil {
		return check(CheckWarn, "could not start postgres to compare the database with this build: %v", err)
	}
	defer stop()

	if err := s.checkNotDowngraded(ctx); err != nil {
		var d *backup.Downgrade
		if errors.As(err, &d) {
			return check(CheckFail, "%v", err)
		}
		return check(CheckWarn, "could not compare the database with this build: %v", err)
	}

	applied, err := s.appliedMigrations(ctx, s.plan.Env.PostgresDB())
	if err != nil {
		return check(CheckWarn, "could not read the applied migrations: %v", err)
	}
	bundled, err := s.bundleMigrations()
	if err != nil {
		return check(CheckWarn, "%v", err)
	}
	pending := backup.Pending(bundled, applied)
	if len(pending) > 0 {
		// Not a fault: the next start applies them, taking a snapshot on the way in.
		return check(CheckOK, "at %s; this build ships up to %s — %d migration(s) will be applied on "+
			"the next start, after a rollback snapshot", backup.Level(applied), backup.Level(bundled), len(pending))
	}
	return check(CheckOK, "at %s, level with this build", backup.Level(bundled))
}

// DoctorText renders the checks for a terminal and reports whether anything failed.
func DoctorText(checks []Check) (string, bool) {
	var b strings.Builder
	failed := false
	for _, c := range checks {
		mark := "✓"
		switch c.Status {
		case CheckWarn:
			mark = "⚠"
		case CheckFail:
			mark = "✗"
			failed = true
		}
		fmt.Fprintf(&b, "%s %-24s %s\n", mark, c.Name, c.Detail)
	}
	return b.String(), failed
}

func writableCheck(dir string) error {
	probe := filepath.Join(dir, ".waffled-write-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(probe)
}

func freeDiskBytes(path string) (uint64, error) { return datadir.FreeBytes(path) }
