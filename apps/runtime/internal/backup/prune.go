package backup

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Retention defaults. Routine dumps are a household's actual safety net, so 14 of them;
// snapshots are rollback points for an upgrade that has already been superseded, so 3.
const (
	DefaultKeepDumps     = 14
	DefaultKeepSnapshots = 3
)

// Prune deletes all but the newest `keep` files of one kind, newest first, and takes
// each file's sidecar with it.
//
// It is deliberately per-kind rather than a glob over the directory: routine dumps and
// pre-migration snapshots live side by side, and a pruner that matched "*.dump" would
// quietly eat the rollback points every time a nightly backup ran.
//
// Retention here is COUNT-based, where the Compose sidecar's is age-based
// (`find -mtime +14 -delete`). That difference is deliberate: a Mac is not a server that
// runs every night. A family Mac that spends a fortnight asleep would come back to an
// age-based pruner deleting every backup it had, having taken no new one — which is
// precisely the moment the backups mattered. Counting keeps the last 14 whenever they
// happened to be taken.
func Prune(dir string, kind Kind, keep int) ([]string, error) {
	if keep < 1 {
		return nil, fmt.Errorf("retention must keep at least one file, got %d", keep)
	}
	files, err := list(dir, kind)
	if err != nil || len(files) <= keep {
		return nil, err
	}

	var removed []string
	for _, f := range files[keep:] {
		if err := os.Remove(f.path); err != nil && !os.IsNotExist(err) {
			return removed, fmt.Errorf("prune %s: %w", f.path, err)
		}
		// The sidecar describes exactly one dump; orphaning it would leave status and
		// restore reading metadata for a file that is gone.
		if err := os.Remove(f.path + SidecarExt); err != nil && !os.IsNotExist(err) {
			return removed, fmt.Errorf("prune %s: %w", f.path+SidecarExt, err)
		}
		removed = append(removed, f.path)
	}
	return removed, nil
}

// entry is one dump file with the time retention orders it by.
type entry struct {
	path string
	at   time.Time
	size int64
}

// list returns the files of one kind, newest first.
func list(dir string, kind Kind) ([]entry, error) {
	dirents, err := os.ReadDir(dir)
	if err != nil {
		// A backups directory that does not exist yet holds nothing to prune or report.
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", dir, err)
	}

	var out []entry
	for _, d := range dirents {
		if d.IsDir() {
			continue
		}
		name := d.Name()
		if (kind == KindDump && !IsDump(name)) || (kind == KindSnapshot && !IsSnapshot(name)) {
			continue
		}
		e := entry{path: filepath.Join(dir, name)}
		info, err := d.Info()
		if err == nil {
			e.size = info.Size()
		}
		if at, ok := StampOf(name); ok {
			e.at = at
		} else if err == nil {
			// Renamed by hand, or written by some other tool. Fall back to the
			// modification time rather than letting an unparseable name sort to an
			// arbitrary end of the list and be deleted first.
			e.at = info.ModTime()
		}
		out = append(out, e)
	}

	// Newest first, with the name as the tie-break so the order is total and stable —
	// two dumps can share a timestamp when a snapshot and a backup land in one second.
	sort.Slice(out, func(i, j int) bool {
		if !out[i].at.Equal(out[j].at) {
			return out[i].at.After(out[j].at)
		}
		return out[i].path > out[j].path
	})
	return out, nil
}
