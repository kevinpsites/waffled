// Package rtstate reads and writes runtime.json — the small file in the data directory
// that remembers the decisions a first run made: which ports were picked, where the
// Postgres unix socket lives, and which bundle build the data was last opened with.
//
// It is deliberately separate from config.env. config.env holds secrets an operator may
// edit; runtime.json holds facts this binary owns and rewrites.
package rtstate

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
)

// Schema is bumped only for a breaking change to the file's shape. A file claiming a
// higher schema was written by a newer runtime and is refused rather than reinterpreted.
const Schema = 1

// Ports records every port the stack listens on. Public and PowerSyncPublic are the two
// Caddy sites (wildcard); the rest are loopback-only.
type Ports struct {
	Public          int `json:"public"`
	PowerSyncPublic int `json:"powersyncPublic"`
	API             int `json:"api"`
	PowerSync       int `json:"powersync"`
	Postgres        int `json:"postgres"`
}

// State is the whole of runtime.json.
type State struct {
	Schema    int    `json:"schema"`
	InstallID string `json:"installId"`
	CreatedAt string `json:"createdAt"`
	Ports     Ports  `json:"ports"`
	// SocketDir is where Postgres puts its unix socket. Normally PGDATA, but macOS caps
	// a unix socket path at 103 bytes, so a deep data directory gets a short temp dir
	// instead and we have to remember which.
	SocketDir string `json:"socketDir,omitempty"`
	// BundleSHA/BundleTime record which bundle build this data directory was last
	// started against. They are written for support — "what was running when this
	// broke?" — and nothing reads them back. In particular they do NOT key the
	// manifest-verification cache: that lives in bundle-verified.json and is keyed on
	// the bundle path, the sha256 of manifest.json, and a stat fingerprint of the tree
	// (see internal/manifest). Changing these two fields changes nothing about whether
	// the bundle is re-verified.
	BundleSHA  string `json:"bundleGitSha,omitempty"`
	BundleTime string `json:"bundleBuiltAt,omitempty"`
	// BackupExcluded records that PGDATA has been marked so Time Machine skips it.
	//
	// It is remembered rather than re-asked because `status` builds a supervisor on
	// every menu-bar poll, and running tmutil twice a second to re-answer a settled
	// question would be a process per poll. Absent (an install from before this field)
	// reads as false, so the next start asserts it. `doctor` still asks tmutil directly,
	// so a data directory that lost the xattr — restored onto another Mac, say — is
	// reported rather than trusted.
	BackupExcluded bool `json:"backupExcluded,omitempty"`
}

// New mints the state a first run starts from.
func New() (*State, error) {
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	return &State{
		Schema:    Schema,
		InstallID: id,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// Load reads runtime.json. A missing file means "first run" and is reported through the
// second return value rather than as an error.
func Load(path string) (*State, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &State{Schema: Schema}, false, nil
		}
		return nil, false, fmt.Errorf("read %s: %w", path, err)
	}
	var s State
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, false, fmt.Errorf("read %s: %w", path, err)
	}
	if s.Schema > Schema {
		return nil, true, fmt.Errorf("%s has schema %d but this waffled-runtime understands %d — "+
			"the data directory was last used by a newer version", path, s.Schema, Schema)
	}
	return &s, true, nil
}

// Save writes runtime.json atomically and readably, through atomicfile — fsynced before
// the rename, because the ports in here are what every device in the household points at.
func Save(path string, s *State) error {
	if s.Schema == 0 {
		s.Schema = Schema
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	raw = append(raw, '\n')

	return atomicfile.WriteFile(path, raw, 0o644)
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate install id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
