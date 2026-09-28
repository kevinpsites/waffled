// Package atomicfile writes a file so that a reader — or a power cut — never sees a
// half-written one.
//
// Both files this runtime owns need it. config.env holds the generated Postgres
// password and JWT secrets, which nothing can regenerate once lost; runtime.json holds
// the ports every device in the household is pointed at. Each had its own hand-rolled
// copy of the temp-file dance, already drifting apart in where they chmod'd, and
// neither fsynced before the rename — so on APFS or ext4 the rename could be journaled
// before the data reached disk, and a power loss at the wrong moment would leave a
// zero-length secret store behind.
package atomicfile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// WriteJSON writes v as the small JSON record this runtime keeps its state in: indented,
// newline-terminated, and replaced atomically at perm.
//
// It exists because every such file — runtime.json, bonjour.json, a dump's sidecar, the
// backup failure note — had its own copy of marshal-append-write, and the copies had
// already begun to drift. The convention is one decision now, not four: indentation
// because these files are read in a terminal when something has gone wrong, and the
// trailing newline so `cat` does not leave the prompt mid-line.
func WriteJSON(path string, v any, perm os.FileMode) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return WriteFile(path, append(raw, '\n'), perm)
}

// ReadJSON decodes what WriteJSON wrote.
//
// The error is returned rather than folded into a bool because absence is a normal answer
// for all of these files — a first run has no runtime.json, a stopped server no
// bonjour.json — and callers tell it from a corrupt file with os.IsNotExist.
func ReadJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	return nil
}

// WriteFile replaces path with data, atomically, at perm.
//
// The temp file is created in the target's own directory so the rename is a same-
// filesystem operation (a cross-device rename is a copy, and not atomic), and it is
// fsynced before the rename so the bytes are durable before anything points at them.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	tmpName := tmp.Name()
	// A no-op once the rename has succeeded; the safety net on every path that has not.
	defer os.Remove(tmpName)

	// Mode before content: the file must never be readable at a looser mode than asked
	// for, not even for the moment it holds the secrets.
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	// Rename carries the temp file's mode across, but say it outright: CreateTemp's
	// 0600 default would otherwise quietly stand in for whatever the caller asked for.
	if err := os.Chmod(path, perm); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
