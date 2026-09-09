package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUnshippedIsWhatTheDatabaseHasAndTheBundleDoesNot(t *testing.T) {
	bundle := []string{"0001_base", "0002_identity", "0099_rhythms"}

	// The update case: the database was migrated by a newer build.
	got := Unshipped(bundle, []string{"0001_base", "0099_rhythms", "0100_update_probe"})
	if len(got) != 1 || got[0] != "0100_update_probe" {
		t.Fatalf("Unshipped = %v, want [0100_update_probe]", got)
	}
	// The ordinary case, and the one that must never be mistaken for a downgrade: a
	// database BEHIND the bundle has migrations pending, not unshipped.
	if n := len(Unshipped(bundle, []string{"0001_base"})); n != 0 {
		t.Errorf("a database behind the bundle reports %d unshipped, want 0 — that is Pending's job", n)
	}
	if n := len(Unshipped(bundle, bundle)); n != 0 {
		t.Errorf("a database level with the bundle reports %d unshipped, want 0", n)
	}
	// A fresh database has applied nothing, so it can be behind but never ahead.
	if n := len(Unshipped(bundle, nil)); n != 0 {
		t.Errorf("an empty database reports %d unshipped, want 0", n)
	}
}

// The snapshot a refused start recommends has to be one THIS build can actually serve.
// Recommending a file that `restore` would then refuse — because it was taken at a
// migration this build does not ship — hands someone a dead end at the worst moment.
func TestNewestRestorablePicksTheNewestSnapshotThisBuildCanServe(t *testing.T) {
	dir := t.TempDir()
	write := func(name, level string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("dump"), 0o600); err != nil {
			t.Fatal(err)
		}
		if level == "" {
			return
		}
		if err := WriteSidecar(filepath.Join(dir, name), Sidecar{Migration: level, TakenAt: "2026-09-08T03:00:00Z"}); err != nil {
			t.Fatal(err)
		}
	}
	write("pre-migrate-0.14.2-to-0.14.3-20260901-030000.dump", "0098_rhythms")
	write("pre-migrate-0.14.3-to-0.15.0-20260905-030000.dump", "0099_rhythms")
	// Newest of all, but taken at a level this build cannot serve: the second update in
	// a row, whose snapshot already holds the schema we are trying to get away from.
	write("pre-migrate-0.15.0-to-0.16.0-20260907-030000.dump", "0100_update_probe")

	got, side, ok := NewestRestorable(dir, "0099_rhythms")
	if !ok {
		t.Fatal("NewestRestorable found nothing, but two of these three are restorable")
	}
	if filepath.Base(got) != "pre-migrate-0.14.3-to-0.15.0-20260905-030000.dump" {
		t.Errorf("NewestRestorable = %s, want the newest snapshot at or below the bundle's level", filepath.Base(got))
	}
	if side.Migration != "0099_rhythms" {
		t.Errorf("the sidecar came back wrong: %+v", side)
	}

	// A routine backup is not a snapshot: the two retention pools are separate, and the
	// question here is specifically "what was the schema like before the update?".
	write("waffled-20260908-030000.dump", "0098_rhythms")
	if got, _, _ := NewestRestorable(dir, "0099_rhythms"); strings.Contains(filepath.Base(got), DumpPrefix) {
		t.Errorf("NewestRestorable picked a routine backup (%s)", filepath.Base(got))
	}
}

// A snapshot with no sidecar cannot be recommended: its level is unreadable without
// unpacking it, and offering a file we cannot promise is restorable is worse than
// admitting there is none.
func TestNewestRestorableIgnoresSnapshotsItCannotVouchFor(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pre-migrate-0.14.3-to-0.15.0-20260905-030000.dump"), []byte("d"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := NewestRestorable(dir, "0099_rhythms"); ok {
		t.Error("NewestRestorable vouched for a snapshot with no sidecar")
	}
	if _, _, ok := NewestRestorable(filepath.Join(dir, "nope"), "0099_rhythms"); ok {
		t.Error("NewestRestorable found something in a directory that does not exist")
	}
}

// What the guard actually SAYS is the deliverable — a person meets this message at the
// moment their server will not start, and it has to tell them what happened and both
// ways out without them reading any code.
func TestDowngradeMessageNamesTheVersionsTheSnapshotAndBothWaysOut(t *testing.T) {
	d := &Downgrade{
		LastVersion: "0.15.0",
		ThisVersion: "0.14.3",
		Unshipped:   []string{"0100_update_probe"},
		BundleLevel: "0099_rhythms",
		BackupsDir:  "/data/backups",
		Snapshot:    "/data/backups/pre-migrate-0.14.3-to-0.15.0-20260905-030000.dump",
		SnapshotAt:  "2026-09-05T03:00:00Z",
	}
	msg := d.Error()
	for _, want := range []string{
		"newer",                      // what happened
		"0.15.0",                     // the version that wrote the data
		"0.14.3",                     // the version refusing
		"0100_update_probe",          // the migration this build does not have
		"re-install",                 // way out 1
		"waffled-runtime restore",    // way out 2
		"--yes",                      // …in a form that can be pasted
		d.Snapshot,                   // …naming the file
		"2026-09-05T03:00:00Z",       // what restoring would cost
		"no migration has been run",  // the reassurance that makes it safe to think…
		"no backup has been deleted", // …in the two terms that actually matter
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the refusal does not mention %q:\n%s", want, msg)
		}
	}
	// The reassurance has to be TRUE, and the old wording was not: by the time this
	// refusal is built, Start has rewritten the managed blocks in postgresql.conf and
	// pg_hba.conf, started the postmaster and run the create-if-not-exists bootstrap.
	// Those steps are how the question gets asked at all — the schema cannot be compared
	// with the cluster shut — so the message is what has to change, not the order. A
	// person reads this line while deciding whether to restore, which is the one
	// irreversible option on offer; it must not overstate what it knows.
	for _, wrong := range []string{
		"before touching the database",
		"Nothing has been changed",
	} {
		if strings.Contains(msg, wrong) {
			t.Errorf("the refusal still claims %q, which is not true by the time it is shown:\n%s", wrong, msg)
		}
	}
	// It must NOT restore anything by itself: the data the newer version wrote is only
	// recoverable while this refuses to touch it.
	if strings.Contains(msg, "has been restored") {
		t.Errorf("the refusal claims to have restored something:\n%s", msg)
	}
}

// The recorded version can equal the running one and the database still be ahead: the
// newer build migrated but never went green, so it never wrote itself down. Saying
// "0.14.3, which is newer than the 0.14.3 trying to start now" is nonsense at the moment
// someone most needs to trust what they are reading.
func TestDowngradeDoesNotCallAVersionNewerThanItself(t *testing.T) {
	d := &Downgrade{
		LastVersion: "0.14.3",
		ThisVersion: "0.14.3",
		Unshipped:   []string{"0100_update_probe"},
		BundleLevel: "0099_rhythms",
		BackupsDir:  "/data/backups",
	}
	msg := d.Error()
	if strings.Contains(msg, "0.14.3, which is newer than") {
		t.Errorf("the refusal claims a version is newer than itself:\n%s", msg)
	}
	if strings.Contains(msg, "re-install Waffled 0.14.3") {
		t.Errorf("the refusal tells someone to re-install the build that is already running:\n%s", msg)
	}
	// It still has to say what happened and still offer both ways out.
	for _, want := range []string{"newer", "0100_update_probe", "re-install", "restore"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the refusal does not mention %q:\n%s", want, msg)
		}
	}
}

// A migration renamed or renumbered in the repo (0084→0086 has happened here) also lands
// in Unshipped, and the two cases need different sentences: telling someone to re-install
// a newer Waffled that never existed sends them looking for a download that is not there.
func TestDowngradeDistinguishesARenamedMigrationFromANewerBuild(t *testing.T) {
	d := &Downgrade{
		ThisVersion: "0.14.3",
		Unshipped:   []string{"0084_waffled_bites"},
		BundleLevel: "0099_rhythms",
		BackupsDir:  "/data/backups",
	}
	msg := d.Error()
	if strings.Contains(msg, "newer Waffled") {
		t.Errorf("a migration older than this build's newest is not evidence of a newer Waffled:\n%s", msg)
	}
	if !strings.Contains(msg, "renamed") {
		t.Errorf("the refusal does not offer the explanation that fits (renamed or removed):\n%s", msg)
	}
	// No version was recorded and no snapshot qualifies: the message must still be
	// complete, and must never print an empty version or an empty filename.
	if strings.Contains(msg, "()") || strings.Contains(msg, "  --yes") || strings.Contains(msg, `""`) {
		t.Errorf("the refusal has a hole where a version or a filename should be:\n%s", msg)
	}
	if !strings.Contains(msg, d.BackupsDir) {
		t.Errorf("with no snapshot to name, the refusal should at least point at %s:\n%s", d.BackupsDir, msg)
	}
}

// The guard has to fire on the data, not on the clock: a snapshot's age decides which
// file to recommend, never whether to refuse.
func TestNewestRestorableOrdersByStampNotByName(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct{ name, level string }{
		{"pre-migrate-0.9.0-to-0.14.3-20260907-030000.dump", "0099_rhythms"},  // newest, sorts LAST as a string
		{"pre-migrate-0.14.1-to-0.14.2-20260101-030000.dump", "0099_rhythms"}, // oldest, sorts FIRST
	} {
		p := filepath.Join(dir, c.name)
		if err := os.WriteFile(p, []byte("d"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := WriteSidecar(p, Sidecar{Migration: c.level, TakenAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
			t.Fatal(err)
		}
	}
	got, _, ok := NewestRestorable(dir, "0099_rhythms")
	if !ok || filepath.Base(got) != "pre-migrate-0.9.0-to-0.14.3-20260907-030000.dump" {
		t.Errorf("NewestRestorable = %s, want the one with the newest timestamp", filepath.Base(got))
	}
}
