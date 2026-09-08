package backup

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MigrationsTable is the table node-pg-migrate keeps, named explicitly in
// apps/api/src/migrate.ts. One row per applied migration, keyed by name.
const MigrationsTable = "pgmigrations"

// MigrationNamesInDir lists a bundle's migrations by the name node-pg-migrate records —
// the filename without its .sql extension — in sorted order.
func MigrationNamesInDir(dir string) ([]string, error) {
	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read the bundled migrations at %s: %w", dir, err)
	}
	var out []string
	for _, d := range dirents {
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".sql") {
			continue
		}
		out = append(out, strings.TrimSuffix(d.Name(), ".sql"))
	}
	sort.Strings(out)
	return out, nil
}

// MigrationNamesFrom extracts the applied migration names from a dump's SQL text.
//
// Both dump formats reduce to the same thing: pg_dump writes table data as a COPY block,
// so `pg_restore --data-only -t pgmigrations` on a custom dump and the plain SQL of a
// gzipped one produce the identical shape, and one parser reads both.
//
// The column index is read out of the COPY header rather than assumed, because
// node-pg-migrate has been free to add columns and a hard-coded index would silently
// start returning timestamps as migration names.
func MigrationNamesFrom(r io.Reader) ([]string, error) {
	sc := bufio.NewScanner(r)
	// Rows are short, but a stray long line elsewhere in a plain dump must not abort the
	// scan before the COPY block is reached.
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)

	nameCol := -1
	var out []string
	for sc.Scan() {
		line := sc.Text()
		if nameCol < 0 {
			if col, ok := copyHeaderNameColumn(line); ok {
				nameCol = col
			}
			continue
		}
		if line == `\.` {
			break
		}
		fields := strings.Split(line, "\t")
		if nameCol < len(fields) {
			out = append(out, fields[nameCol])
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read the migration data out of the dump: %w", err)
	}
	// No COPY block is not a parse failure: it is a dump whose level we cannot know,
	// which the caller warns about rather than refusing.
	return out, nil
}

// copyHeaderNameColumn recognises the COPY line for pgmigrations and reports which
// column holds the migration name.
func copyHeaderNameColumn(line string) (int, bool) {
	if !strings.HasPrefix(line, "COPY ") || !strings.Contains(line, MigrationsTable) {
		return 0, false
	}
	open := strings.Index(line, "(")
	close := strings.Index(line, ")")
	if open < 0 || close < open {
		return 0, false
	}
	for i, col := range strings.Split(line[open+1:close], ",") {
		if strings.Trim(strings.TrimSpace(col), `"`) == "name" {
			return i, true
		}
	}
	return 0, false
}

// Level is the highest migration in a set — the "schema level" of a database or a dump.
// Migration files carry a zero-padded four-digit prefix, so the lexical maximum is the
// numeric one.
func Level(names []string) string {
	max := ""
	for _, n := range names {
		if n > max {
			max = n
		}
	}
	return max
}

// CheckRestorable refuses a dump the running bundle is too old to serve.
//
// Restoring a newer schema into an older build is the one unrecoverable direction:
// migrations only run forward, so the api would come up against tables and columns its
// code does not know, and there is nothing to migrate the data back down with. An
// unknown level (a dump we could not read the table out of) is allowed — the caller
// warns — because refusing every dump we cannot parse would block the Docker-to-Mac
// migration this whole path exists for.
func CheckRestorable(dumpLevel, bundleLevel string) error {
	if dumpLevel == "" || bundleLevel == "" {
		return nil
	}
	if dumpLevel > bundleLevel {
		return fmt.Errorf(
			"this dump was taken at migration %s but this build only ships up to %s.\n"+
				"Restoring it would leave the database ahead of the code, and migrations only run "+
				"forward. Update Waffled to a build that includes %s, then restore again",
			dumpLevel, bundleLevel, dumpLevel)
	}
	return nil
}

// Pending is what the bundle ships and the database has not applied.
//
// Compared by NAME, never by count or by maximum: the api runs node-pg-migrate with
// checkOrder:false, so a database can legitimately hold a later migration while an
// earlier one is still pending, and counting rows would call that case up to date.
func Pending(bundle, applied []string) []string {
	have := make(map[string]bool, len(applied))
	for _, a := range applied {
		have[a] = true
	}
	var out []string
	for _, b := range bundle {
		if !have[b] {
			out = append(out, b)
		}
	}
	sort.Strings(out)
	return out
}

// MigrationsDir resolves the bundle's migrations directory, defaulting to the documented
// layout when the manifest does not name one.
func MigrationsDir(bundle, fromManifest string) string {
	if fromManifest == "" {
		fromManifest = "api/migrations"
	}
	return filepath.Join(bundle, fromManifest)
}
