package backup

import (
	"testing"
	"time"
)

func TestDumpNameIsUTCAndSortable(t *testing.T) {
	// A timestamp deliberately given in a non-UTC zone: the name must be the UTC
	// instant, because two Macs in different time zones must produce names that sort
	// into one true chronological order.
	zone := time.FixedZone("UTC+5", 5*60*60)
	at := time.Date(2026, 9, 8, 4, 30, 5, 0, zone) // 2026-09-07T23:30:05Z

	got := DumpName(at)
	if want := "waffled-20260907-233005.dump"; got != want {
		t.Errorf("DumpName = %q, want %q", got, want)
	}
	if !IsDump(got) {
		t.Errorf("%q should be recognised as a routine dump", got)
	}
}

// A snapshot is taken because a schema is about to cross from one build to another, so
// its name has to answer both halves of "which build was this taken before?" — the one
// that wrote the data and the one about to change it. Only the second is knowable from
// the running binary, which is why the first is remembered in runtime.json.
func TestSnapshotNameCarriesBothVersions(t *testing.T) {
	at := time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC)
	got := SnapshotName("0.14.3", "0.15.0", at)
	if want := "pre-migrate-0.14.3-to-0.15.0-20260908-030000.dump"; got != want {
		t.Errorf("SnapshotName = %q, want %q", got, want)
	}
	if !IsSnapshot(got) {
		t.Errorf("%q should be recognised as a snapshot", got)
	}
	if IsDump(got) {
		t.Errorf("%q is a snapshot, not a routine dump — the two retention pools must not overlap", got)
	}
	if _, ok := StampOf(got); !ok {
		t.Errorf("StampOf could not read the timestamp back out of %q", got)
	}
}

// Data written before the from-version was recorded has no answer to "which build wrote
// this?". The name must say so rather than leave a hole a reader would mistake for the
// other version.
func TestSnapshotNameSaysUnknownWhenThereIsNoFromVersion(t *testing.T) {
	at := time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC)
	got := SnapshotName("", "0.15.0", at)
	if want := "pre-migrate-unknown-to-0.15.0-20260908-030000.dump"; got != want {
		t.Errorf("SnapshotName = %q, want %q", got, want)
	}
	if _, ok := StampOf(got); !ok {
		t.Errorf("StampOf could not read the timestamp back out of %q", got)
	}
}

// A version with no dots, or one an operator has hand-edited, must not produce a name
// the stamp parser cannot read back — that is what keeps snapshot pruning chronological.
func TestSnapshotNameSanitisesBothVersions(t *testing.T) {
	at := time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC)
	got := SnapshotName("0.14.3 (dirty)/../etc", "0.15.0 (dirty)", at)
	if want := "pre-migrate-0.14.3-dirty-etc-to-0.15.0-dirty-20260908-030000.dump"; got != want {
		t.Errorf("SnapshotName = %q, want %q", got, want)
	}
	if _, ok := StampOf(got); !ok {
		t.Errorf("StampOf could not read the timestamp back out of %q", got)
	}
}

func TestStampOfReadsTheTimestampBack(t *testing.T) {
	cases := []struct {
		name string
		want time.Time
		ok   bool
	}{
		{"waffled-20260907-233005.dump", time.Date(2026, 9, 7, 23, 30, 5, 0, time.UTC), true},
		{"pre-migrate-0.14.3-20260908-030000.dump", time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC), true},
		// A version containing a dash must not confuse the parser: only the LAST two
		// dash-separated fields are the stamp.
		{"pre-migrate-1.0.0-rc.1-20260908-030000.dump", time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC), true},
		{"waffled-nonsense.dump", time.Time{}, false},
		{"waffled-20260701-020000.sql.gz", time.Date(2026, 7, 1, 2, 0, 0, 0, time.UTC), true},
		{"notours.dump", time.Time{}, false},
	}
	for _, c := range cases {
		got, ok := StampOf(c.name)
		if ok != c.ok {
			t.Errorf("StampOf(%q) ok = %v, want %v", c.name, ok, c.ok)
			continue
		}
		if ok && !got.Equal(c.want) {
			t.Errorf("StampOf(%q) = %s, want %s", c.name, got, c.want)
		}
	}
}

// The Docker sidecar writes waffled-<stamp>.sql.gz. Someone moving a household from
// Compose to the Mac app restores exactly that file, so restore has to recognise it.
func TestFormatOfRecognisesBothOurDumpsAndTheDockerSidecars(t *testing.T) {
	cases := []struct {
		name string
		want Format
	}{
		{"waffled-20260907-233005.dump", FormatCustom},
		{"/tmp/somewhere/pre-migrate-0.14.3-20260908-030000.dump", FormatCustom},
		{"waffled-20260701-020000.sql.gz", FormatPlainGzip},
		{"hand-made.sql", FormatPlain},
		{"holiday-photos.zip", FormatUnknown},
	}
	for _, c := range cases {
		if got := FormatOf(c.name); got != c.want {
			t.Errorf("FormatOf(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}
