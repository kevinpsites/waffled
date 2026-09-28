// Package backup owns everything about a dump file that does not need a database: what
// it is called, which pool it belongs to, how many are kept, what is recorded beside it,
// and how its migration level is read back out.
//
// It is deliberately pure — no exec, no Postgres — so the parts that are easy to get
// subtly wrong and expensive to discover at 03:00 (a pruner that eats the rollback
// points, a name that sorts differently in two time zones, a level comparison that
// permits a restore the schema cannot carry) are all under fast unit tests.
// internal/supervisor drives pg_dump and pg_restore around it.
package backup

import (
	"path/filepath"
	"strings"
	"time"
)

// Prefixes for the two pools that share the backups directory.
const (
	// DumpPrefix marks a routine backup: what `backup` writes and retention keeps 14 of.
	DumpPrefix = "waffled-"
	// SnapshotPrefix marks a rollback point taken automatically before migrations run.
	// Distinct from DumpPrefix so the two retention pools can never prune each other.
	SnapshotPrefix = "pre-migrate-"
	// DumpExt is pg_dump's custom format (-Fc), which is what pg_restore reads.
	DumpExt = ".dump"
	// SidecarExt is appended to a dump's name for the JSON written beside it.
	SidecarExt = ".json"
)

// Kind selects a retention pool.
type Kind int

const (
	// KindDump is the routine backups pool.
	KindDump Kind = iota
	// KindSnapshot is the pre-migration rollback points pool.
	KindSnapshot
)

// stampLayout is the UTC timestamp in every generated name. It matches the Compose
// sidecar's `date -u +%Y%m%d-%H%M%S`, so a backups folder carried over from Docker sorts
// in with ours instead of forming a separate, confusing series.
const stampLayout = "20060102-150405"

// DumpName is the file a routine backup writes. Always UTC: two Macs in different time
// zones must produce names that sort into one true chronological order.
func DumpName(at time.Time) string {
	return DumpPrefix + at.UTC().Format(stampLayout) + DumpExt
}

// SnapshotName is the file a pre-migration snapshot writes.
//
// Both versions are in the name because a snapshot marks a crossing, and the question
// anyone asks of a rollback point is which way it was going: `from` wrote the data (read
// back out of runtime.json, since a running binary cannot know it) and `to` is the build
// about to change the schema. An empty `from` becomes "unknown" — data written before
// that was recorded genuinely has no answer, and a hole in the name would read as the
// other version.
//
// Names written by earlier builds carry a single version and still parse: StampOf reads
// the last two dash-separated fields, and everything before them is prose.
func SnapshotName(from, to string, at time.Time) string {
	return SnapshotPrefix + sanitizeVersion(from) + "-to-" + sanitizeVersion(to) +
		"-" + at.UTC().Format(stampLayout) + DumpExt
}

// IsDump and IsSnapshot classify a file into exactly one pool, or neither.
func IsDump(name string) bool {
	base := filepath.Base(name)
	return strings.HasPrefix(base, DumpPrefix) && strings.HasSuffix(base, DumpExt)
}

func IsSnapshot(name string) bool {
	base := filepath.Base(name)
	return strings.HasPrefix(base, SnapshotPrefix) && strings.HasSuffix(base, DumpExt)
}

// StampOf reads the UTC timestamp back out of a generated name.
//
// It takes the LAST two dash-separated fields, never the first two: a snapshot name
// carries a version before its stamp, and versions contain dashes ("1.0.0-rc.1"). It is
// also what makes snapshot pruning chronological — sorting those names as strings puts
// 0.9.0 after 0.14.3 and would delete the newest rollback point.
func StampOf(name string) (time.Time, bool) {
	base := filepath.Base(name)
	if !strings.HasPrefix(base, DumpPrefix) && !strings.HasPrefix(base, SnapshotPrefix) {
		return time.Time{}, false
	}
	base = trimDumpExtensions(base)
	fields := strings.Split(base, "-")
	if len(fields) < 2 {
		return time.Time{}, false
	}
	stamp := strings.Join(fields[len(fields)-2:], "-")
	at, err := time.ParseInLocation(stampLayout, stamp, time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return at, true
}

// Format is how a dump file has to be fed back into Postgres.
type Format int

const (
	// FormatUnknown is anything we would not hand to psql or pg_restore.
	FormatUnknown Format = iota
	// FormatCustom is pg_dump -Fc: restored with pg_restore.
	FormatCustom
	// FormatPlain is a plain SQL script: restored by piping into psql.
	FormatPlain
	// FormatPlainGzip is a gzipped plain SQL script — what the Compose backup sidecar
	// writes. Supporting it is the whole Docker-to-Mac migration path.
	FormatPlainGzip
)

func (f Format) String() string {
	switch f {
	case FormatCustom:
		return "custom (pg_dump -Fc)"
	case FormatPlain:
		return "plain SQL"
	case FormatPlainGzip:
		return "gzipped plain SQL"
	default:
		return "unrecognised"
	}
}

// FormatOf classifies a dump by its name. The name is enough for every file either half
// of this project produces, and a wrong guess fails loudly at restore rather than
// quietly, so sniffing the magic bytes buys nothing.
func FormatOf(path string) Format {
	base := filepath.Base(path)
	switch {
	case strings.HasSuffix(base, DumpExt):
		return FormatCustom
	case strings.HasSuffix(base, ".sql.gz"):
		return FormatPlainGzip
	case strings.HasSuffix(base, ".sql"):
		return FormatPlain
	default:
		return FormatUnknown
	}
}

// trimDumpExtensions removes the suffixes we actually produce, one at a time.
//
// filepath.Ext cannot be used here: a snapshot name embeds a dotted version, so the
// "final dot" in pre-migrate-0.14.3-20260908-030000.dump is the one inside 0.14.3, and
// stripping from there would swallow the timestamp this function exists to find.
func trimDumpExtensions(base string) string {
	for {
		trimmed := base
		for _, ext := range []string{SidecarExt, DumpExt, ".gz", ".sql"} {
			trimmed = strings.TrimSuffix(trimmed, ext)
		}
		if trimmed == base {
			return base
		}
		base = trimmed
	}
}

// sanitizeVersion keeps a hand-edited or dirty version string from producing a filename
// with a path separator, a space, or anything else StampOf could not read back.
//
// It splits on everything that is not alphanumeric or a dot, trims dots off each piece
// (so a "../" in the input cannot survive as a path component) and rejoins with dashes.
func sanitizeVersion(v string) string {
	pieces := strings.FieldsFunc(v, func(r rune) bool {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '.':
			return false
		default:
			return true
		}
	})
	var kept []string
	for _, p := range pieces {
		if p = strings.Trim(p, "."); p != "" {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		return "unknown"
	}
	return strings.Join(kept, "-")
}
