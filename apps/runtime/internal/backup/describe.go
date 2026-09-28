package backup

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

// Sidecar is the JSON written beside every dump this runtime takes.
//
// It exists because a dump does not otherwise say what it is: pg_restore's table of
// contents names the pgmigrations table but not its rows, so reading a dump's schema
// level means unpacking it. The sidecar answers that (and "which build wrote this")
// instantly, which is what makes `status` cheap and a pre-restore check fast. Dumps
// without one — anything the Compose sidecar wrote — still work; the level is read out
// of the dump itself instead.
type Sidecar struct {
	WaffledVersion string `json:"waffledVersion"`
	GitSha         string `json:"gitSha"`
	// Migration is the highest applied migration at the moment of the dump.
	Migration string `json:"migration"`
	Database  string `json:"database"`
	// Collation is recorded because a dump restored into a differently collated cluster
	// sorts differently and reports a collation-version mismatch on every index.
	Collation string `json:"collation"`
	SizeBytes int64  `json:"sizeBytes"`
	TakenAt   string `json:"takenAt"`
	// FromVersion and ToVersion are set on a pre-migrate snapshot only, and record the
	// crossing it was taken for: the build that wrote the data, and the build about to
	// change its schema. A routine backup leaves them empty — it marks no crossing, and
	// its WaffledVersion above already says which build took it.
	//
	// They are in here as well as in the filename because a filename is prose: reading
	// a crossing back out of one means splitting on dashes that also appear inside
	// versions, and the whole reason this file exists is not having to do that.
	FromVersion string `json:"fromVersion,omitempty"`
	ToVersion   string `json:"toVersion,omitempty"`
}

// WriteSidecar records a dump's metadata beside it.
func WriteSidecar(dumpPath string, s Sidecar) error {
	if err := atomicfile.WriteJSON(dumpPath+SidecarExt, s, 0o600); err != nil {
		return fmt.Errorf("encode the backup metadata: %w", err)
	}
	return nil
}

// ReadSidecar reads a dump's metadata. Absence is a normal answer, not an error.
func ReadSidecar(dumpPath string) (Sidecar, bool) {
	var s Sidecar
	if err := atomicfile.ReadJSON(dumpPath+SidecarExt, &s); err != nil {
		return Sidecar{}, false
	}
	return s, true
}

// failureFile records the last failed run. A failed backup leaves no dump behind, so
// without this `status` would show the last SUCCESS and call a week of broken nightly
// runs fine.
const failureFile = "last-error.json"

type failure struct {
	At    string `json:"at"`
	Error string `json:"error"`
}

// RecordFailure notes that a backup failed, for `status` and `doctor` to surface.
func RecordFailure(dir string, at time.Time, msg string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f := failure{At: at.UTC().Format(time.RFC3339), Error: msg}
	return atomicfile.WriteJSON(filepath.Join(dir, failureFile), f, 0o600)
}

// ClearFailure forgets the last failure. A successful run calls it: leaving a week-old
// error beside a fresh backup reads as "backups are broken" when they are not.
func ClearFailure(dir string) error {
	err := os.Remove(filepath.Join(dir, failureFile))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Describe builds the `backups` block of `status --json`. `scheduleAt` is the nightly
// time the installed launchd agent names, empty when there is none to read.
//
// It reads the filesystem, never the database. "When did it last back up?" is asked
// exactly when the stack is down — and `status` is the one command that must answer with
// Postgres stopped. backup_runs remains the api-facing mirror of the same facts, for
// System Health, which can only be reached when the api is up anyway.
func Describe(dir string, scheduleInstalled bool, scheduleAt string) status.Backups {
	out := status.Backups{
		Dir:               dir,
		ScheduleInstalled: scheduleInstalled,
		ScheduleAt:        scheduleAt,
	}
	// Snapshots are deliberately not considered: a pre-migration rollback point is not a
	// backup anyone should be told to rely on, and it would otherwise mask a nightly
	// schedule that has silently stopped running.
	dumps, err := list(dir, KindDump)
	if err != nil {
		out.LastError = err.Error()
		return out
	}
	out.Count = len(dumps)
	if len(dumps) > 0 {
		newest := dumps[0]
		out.LastPath = newest.path
		out.LastSizeBytes = newest.size
		if !newest.at.IsZero() {
			out.LastBackupAt = newest.at.UTC().Format(time.RFC3339)
		}
		if s, ok := ReadSidecar(newest.path); ok {
			out.LastMigration = s.Migration
		}
	}
	var f failure
	if atomicfile.ReadJSON(filepath.Join(dir, failureFile), &f) == nil {
		out.LastError, out.LastErrorAt = f.Error, f.At
	}
	return out
}
