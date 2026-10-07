package backup

import (
	"fmt"
	"sort"
	"strings"
)

// Unshipped is what the database has applied that this bundle does not ship — the mirror
// of Pending, and the thing that says an OLDER build is being pointed at data a newer one
// has already migrated.
//
// Note which way round the arguments read: Pending(bundle, applied) is the bundle's
// news, Unshipped(bundle, applied) is the database's. Both compare by NAME rather than by
// count or by maximum, for the same reason — the api runs node-pg-migrate with
// checkOrder:false, so neither list is a prefix of the other.
func Unshipped(bundle, applied []string) []string {
	ships := make(map[string]bool, len(bundle))
	for _, b := range bundle {
		ships[b] = true
	}
	var out []string
	for _, a := range applied {
		if !ships[a] {
			out = append(out, a)
		}
	}
	sort.Strings(out)
	return out
}

// NewestRestorable is the most recent pre-migrate snapshot a bundle at bundleLevel could
// actually restore, with its sidecar.
//
// Only snapshots, and only ones with a sidecar. A routine backup is a different pool
// answering a different question ("what did last night look like?"), and a snapshot whose
// level we cannot read without unpacking it cannot be promised — recommending a file that
// `restore` would then refuse hands someone a dead end at the exact moment they are least
// able to absorb one. No such file is a normal answer, reported through ok.
func NewestRestorable(dir, bundleLevel string) (string, Sidecar, bool) {
	entries, err := list(dir, KindSnapshot)
	if err != nil {
		return "", Sidecar{}, false
	}
	// list is newest first, so the first acceptable one is the answer.
	for _, e := range entries {
		side, ok := ReadSidecar(e.path)
		if !ok || side.Migration == "" {
			continue
		}
		if CheckRestorable(side.Migration, bundleLevel) != nil {
			continue
		}
		return e.path, side, true
	}
	return "", Sidecar{}, false
}

// Downgrade is the refusal a start makes when the database has migrations this build does
// not ship. It is an error type rather than a formatted string so that what it SAYS can be
// unit-tested: this message is met by a person whose server has just refused to start, and
// getting the wording right matters as much as getting the check right.
//
// It deliberately does not restore anything. The data a newer version wrote is only
// recoverable while nothing touches it, and a guard that "helpfully" rolled the database
// back to the last snapshot would destroy exactly what someone re-installing the newer
// version is trying to keep.
type Downgrade struct {
	// LastVersion is what runtime.json recorded, or "" on data from before that was
	// written down. ThisVersion is the build refusing.
	LastVersion string
	ThisVersion string
	// Unshipped is the applied migration names this build does not have, and BundleLevel
	// the newest it does. Together they separate "a newer Waffled wrote this" from "a
	// migration was renamed", which need different advice.
	Unshipped   []string
	BundleLevel string
	// BackupsDir is where to look when no single snapshot can be recommended.
	// Snapshot/SnapshotAt name the one that can, when there is one.
	BackupsDir string
	Snapshot   string
	SnapshotAt string
}

func (d *Downgrade) Error() string {
	var b strings.Builder

	if d.fromANewerBuild() {
		if d.namedNewerVersion() != "" {
			fmt.Fprintf(&b, "this data was last used by Waffled %s, which is newer than the %s trying to start now.\n",
				d.namedNewerVersion(), d.versionOrThis())
		} else {
			fmt.Fprintf(&b, "this data was last used by a newer Waffled than the %s trying to start now.\n",
				d.versionOrThis())
		}
		fmt.Fprintf(&b, "The database has %s this build does not ship, and migrations only run forward — "+
			"there is nothing to bring the schema back down, so starting would leave the server "+
			"answering against tables and columns its code does not know about.\n", d.migrationsPhrase())
	} else {
		// Everything unshipped is OLDER than this build's newest migration, so a newer
		// Waffled is not the explanation. Saying it was would send someone looking for a
		// download that does not exist.
		fmt.Fprintf(&b, "this data has %s that this build does not ship, all of them older than its "+
			"newest (%s) — they were most likely renamed or renumbered rather than written by a "+
			"later build.\n", d.migrationsPhrase(), d.BundleLevel)
		b.WriteString("Starting anyway would re-run them under their new names against objects that " +
			"already exist, so the migration would fail partway through instead of here.\n")
	}

	b.WriteString("\nTwo ways out:\n")
	if d.fromANewerBuild() {
		if d.namedNewerVersion() != "" {
			fmt.Fprintf(&b, "  · re-install Waffled %s and start again — nothing here is lost; or\n", d.namedNewerVersion())
		} else {
			b.WriteString("  · re-install the newer version of Waffled and start again — nothing here is lost; or\n")
		}
	} else {
		b.WriteString("  · run the build that created this data, if you still have it; or\n")
	}
	if d.Snapshot != "" {
		b.WriteString("  · restore the snapshot taken before that change, which this build can serve:\n")
		fmt.Fprintf(&b, "      waffled-runtime restore %q --yes\n", d.Snapshot)
		if d.SnapshotAt != "" {
			fmt.Fprintf(&b, "    That is the database as it was at %s; anything written after it is lost.\n", d.SnapshotAt)
		}
	} else {
		fmt.Fprintf(&b, "  · restore a backup taken before that change with "+
			"`waffled-runtime restore <file> --yes` — no snapshot in %s is old enough for this "+
			"build to serve, so it would have to be one of your own.\n", d.BackupsDir)
	}
	// Precisely what it can promise, and no more. Getting far enough to ASK this question
	// means Start has already rewritten the managed blocks in postgresql.conf and
	// pg_hba.conf, started the postmaster and run the create-if-not-exists bootstrap —
	// the schema cannot be compared with the cluster shut. None of that changes what is
	// stored, which is the thing being asked about, so the reassurance stands; the older
	// wording ("this stopped before touching the database") simply was not true, and this
	// line is read at the moment someone is deciding whether to restore, which is the one
	// irreversible option on the page.
	b.WriteString("\nYour data is intact: no migration has been run, nothing in the database has " +
		"been rewritten or removed, and no backup has been deleted. Starting did get as far as " +
		"opening the cluster — the managed blocks in postgresql.conf and pg_hba.conf were brought " +
		"up to date, and the create-if-not-exists bootstrap ran with nothing to do — but it stopped " +
		"before anything could change what is stored. Restoring is the one step here that discards " +
		"anything.")
	return b.String()
}

// fromANewerBuild reports whether anything unshipped sits ABOVE this bundle's newest
// migration. That is the discriminator between the two explanations, and a mixed set
// counts as newer: one genuinely-ahead migration is enough to make re-installing the
// newer version the right first suggestion.
func (d *Downgrade) fromANewerBuild() bool {
	for _, name := range d.Unshipped {
		if d.BundleLevel == "" || name > d.BundleLevel {
			return true
		}
	}
	return false
}

// namedNewerVersion is the version to call "the newer one", or "" when we cannot name it.
//
// The recorded version is only evidence of a newer build when it DIFFERS from the one
// running. It can legitimately be the same: the newer build migrated the database and
// then failed before it went green, so it never wrote itself down — and telling someone
// their 0.14.3 data is newer than the 0.14.3 refusing to open it reads as a bug in the
// message at the moment they most need to trust it. The database is still ahead, so the
// refusal stands; it just cannot say which build did it.
func (d *Downgrade) namedNewerVersion() string {
	if d.LastVersion == d.ThisVersion {
		return ""
	}
	return d.LastVersion
}

func (d *Downgrade) versionOrThis() string {
	if d.ThisVersion == "" {
		return "build"
	}
	return d.ThisVersion
}

// migrationsPhrase names them when there are few and counts them when there are many —
// a refusal listing forty migration names is a wall nobody reads.
func (d *Downgrade) migrationsPhrase() string {
	const listAtMost = 3
	n := len(d.Unshipped)
	noun := "migrations"
	if n == 1 {
		noun = "migration"
	}
	if n <= listAtMost {
		return fmt.Sprintf("%d %s (%s)", n, noun, strings.Join(d.Unshipped, ", "))
	}
	return fmt.Sprintf("%d %s (%s and %d more)", n, noun,
		strings.Join(d.Unshipped[:listAtMost], ", "), n-listAtMost)
}
