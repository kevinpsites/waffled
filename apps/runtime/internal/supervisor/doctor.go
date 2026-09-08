package supervisor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
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
		add("bundle manifest", CheckOK, "%d files + %d symlinks verified — %s",
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
	b := backup.Describe(s.plan.Layout.Backups, s.scheduleInstalled())
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
			add("backup schedule", CheckOK, "a nightly backup is installed and loaded (%s)", schedule.Label)
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

	if !s.postgresInitialized() {
		add("postgres", CheckWarn, "no database cluster yet — it is created on the first start")
		return checks
	}

	pid, running := s.postgresPid()
	if !running {
		add("postgres", CheckWarn, "not running")
		return checks
	}
	add("postgres", CheckOK, "running (pid %d) on 127.0.0.1:%d", pid, s.plan.Ports.Postgres)

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

func freeDiskBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}
