package backup

import (
	"strings"
	"testing"
)

// The COPY block pg_dump emits for pgmigrations. Column order is read from the header
// rather than assumed, because node-pg-migrate has been free to add columns.
const pgmigrationsCopy = `--
-- Data for Name: pgmigrations; Type: TABLE DATA; Schema: public; Owner: waffled
--

COPY public.pgmigrations (id, name, run_on) FROM stdin;
1	0001_base	2026-01-01 00:00:00
2	0002_identity	2026-01-01 00:00:01
3	0099_rhythm_book_within	2026-09-01 00:00:00
\.


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: waffled
--
`

func TestMigrationNamesFromDumpReadsTheCopyBlock(t *testing.T) {
	got, err := MigrationNamesFrom(strings.NewReader(pgmigrationsCopy))
	if err != nil {
		t.Fatalf("MigrationNamesFrom: %v", err)
	}
	want := []string{"0001_base", "0002_identity", "0099_rhythm_book_within"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// The name column is not always third. Reading its index out of the COPY header is the
// difference between a correct level and a timestamp parsed as a migration name.
func TestMigrationNamesFromHonoursTheColumnOrder(t *testing.T) {
	body := "COPY public.pgmigrations (name, id, run_on) FROM stdin;\n" +
		"0007_meals\t7\t2026-01-01 00:00:00\n" +
		"\\.\n"
	got, err := MigrationNamesFrom(strings.NewReader(body))
	if err != nil {
		t.Fatalf("MigrationNamesFrom: %v", err)
	}
	if len(got) != 1 || got[0] != "0007_meals" {
		t.Fatalf("got %v, want [0007_meals]", got)
	}
}

// A dump with no pgmigrations data at all is not a parse failure — it is a dump whose
// level we cannot know, which restore must treat as a warning rather than a refusal.
func TestMigrationNamesFromReportsNothingRatherThanFailing(t *testing.T) {
	got, err := MigrationNamesFrom(strings.NewReader("-- an empty database\n"))
	if err != nil {
		t.Fatalf("MigrationNamesFrom: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want nothing", got)
	}
}

func TestLevelIsTheHighestMigrationName(t *testing.T) {
	// Zero-padded four-digit prefixes make the lexical maximum the numeric one.
	got := Level([]string{"0002_identity", "0100_chore_instance_history", "0099_rhythms"})
	if got != "0100_chore_instance_history" {
		t.Errorf("Level = %q, want 0100_chore_instance_history", got)
	}
	if Level(nil) != "" {
		t.Errorf("Level(nil) = %q, want the empty string", Level(nil))
	}
}

func TestBundleIsNewerThanOrLevelWith(t *testing.T) {
	bundle := []string{"0001_base", "0002_identity", "0099_rhythms"}

	cases := []struct {
		name    string
		dump    []string
		refuse  bool
		because string
	}{
		{"an older dump restores fine", []string{"0001_base"}, false, ""},
		{"the same level restores fine", []string{"0001_base", "0099_rhythms"}, false, ""},
		{"a newer dump is refused", []string{"0001_base", "0100_chore_instance_history"}, true,
			"the bundle would have no migration for 0100"},
		{"an unknown level is allowed", nil, false, "we cannot read it, so we warn instead"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := CheckRestorable(Level(c.dump), Level(bundle))
			if c.refuse && err == nil {
				t.Fatalf("CheckRestorable allowed a dump it should refuse (%s)", c.because)
			}
			if !c.refuse && err != nil {
				t.Fatalf("CheckRestorable refused a dump it should allow: %v", err)
			}
			if c.refuse && !strings.Contains(err.Error(), "0100_chore_instance_history") {
				t.Errorf("the refusal should name the migration the bundle lacks: %v", err)
			}
		})
	}
}

func TestPendingIsWhatTheBundleHasAndTheDatabaseDoesNot(t *testing.T) {
	bundle := []string{"0001_base", "0002_identity", "0099_rhythms"}
	applied := []string{"0001_base", "0099_rhythms"}

	got := Pending(bundle, applied)
	if len(got) != 1 || got[0] != "0002_identity" {
		t.Fatalf("Pending = %v, want [0002_identity]", got)
	}

	// node-pg-migrate runs with checkOrder:false, so a database can legitimately hold a
	// later migration while an earlier one is still pending. Comparing by NAME, not by
	// count or by maximum, is what makes that case come out right.
	if n := len(Pending(bundle, bundle)); n != 0 {
		t.Errorf("a fully migrated database reports %d pending, want 0", n)
	}
	if n := len(Pending(bundle, nil)); n != 3 {
		t.Errorf("an empty database reports %d pending, want 3", n)
	}
}

func TestMigrationNamesFromDirectoryStripsTheExtension(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "0001_base.sql")
	writeFile(t, dir, "0002_identity.sql")
	writeFile(t, dir, "README.md") // not a migration
	writeFile(t, dir, "0010_later.sql")

	got, err := MigrationNamesInDir(dir)
	if err != nil {
		t.Fatalf("MigrationNamesInDir: %v", err)
	}
	want := []string{"0001_base", "0002_identity", "0010_later"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
