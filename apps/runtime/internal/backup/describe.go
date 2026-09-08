package backup

import (
	"encoding/json"
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
}

// WriteSidecar records a dump's metadata beside it.
func WriteSidecar(dumpPath string, s Sidecar) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the backup metadata: %w", err)
	}
	return atomicfile.WriteFile(dumpPath+SidecarExt, append(raw, '\n'), 0o600)
}

// ReadSidecar reads a dump's metadata. Absence is a normal answer, not an error.
func ReadSidecar(dumpPath string) (Sidecar, bool) {
	raw, err := os.ReadFile(dumpPath + SidecarExt)
	if err != nil {
		return Sidecar{}, false
	}
	var s Sidecar
	if err := json.Unmarshal(raw, &s); err != nil {
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
	raw, err := json.MarshalIndent(failure{At: at.UTC().Format(time.RFC3339), Error: msg}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(dir, failureFile), append(raw, '\n'), 0o600)
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

// Describe builds the `backups` block of `status --json`.
//
// It reads the filesystem, never the database. "When did it last back up?" is asked
// exactly when the stack is down — and `status` is the one command that must answer with
// Postgres stopped. backup_runs remains the api-facing mirror of the same facts, for
// System Health, which can only be reached when the api is up anyway.
func Describe(dir string, scheduleInstalled bool) status.Backups {
	out := status.Backups{
		Dir:               dir,
		ScheduleInstalled: scheduleInstalled,
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
	if raw, err := os.ReadFile(filepath.Join(dir, failureFile)); err == nil {
		var f failure
		if json.Unmarshal(raw, &f) == nil {
			out.LastError, out.LastErrorAt = f.Error, f.At
		}
	}
	return out
}
