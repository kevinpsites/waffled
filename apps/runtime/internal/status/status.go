// Package status defines what `waffled-runtime status --json` emits.
//
// This is a published contract: the menu-bar app (Phase 3) polls it to decide which icon
// to draw and what to put in the menu, and support asks people to paste it. Field names
// and the four service states are therefore API — add fields freely, rename nothing, and
// bump Schema for anything breaking.
package status

import (
	"fmt"
	"strings"
	"time"
)

// Schema is the version of this document's shape.
const Schema = 1

// The four service states, and the overall state derived from them.
const (
	// StateStopped: not running.
	StateStopped = "stopped"
	// StateStarting: the process exists but has not passed its health check yet.
	StateStarting = "starting"
	// StateRunning: process up and health check green.
	StateRunning = "running"
	// StateUnhealthy: the process is gone when it should not be, or it is up but failing
	// its health check.
	StateUnhealthy = "unhealthy"
)

// Ports mirrors runtime.json.
type Ports struct {
	Public          int `json:"public"`
	PowerSyncPublic int `json:"powersyncPublic"`
	API             int `json:"api"`
	PowerSync       int `json:"powersync"`
	Postgres        int `json:"postgres"`
}

// Versions come from the bundle manifest, never from running --version at start.
type Versions struct {
	Waffled   string `json:"waffled"`
	Node      string `json:"node"`
	Postgres  string `json:"postgres"`
	Caddy     string `json:"caddy"`
	PowerSync string `json:"powersync"`
	API       string `json:"api"`
	Web       string `json:"web"`
}

// Bundle identifies the build the data is being served by, and how it got here.
type Bundle struct {
	GitSha   string `json:"gitSha"`
	BuiltAt  string `json:"builtAt"`
	Arch     string `json:"arch"`
	Platform string `json:"platform"`
	Verified bool   `json:"verified"`
	// Version is this bundle's Waffled version. It repeats versions.waffled — the two
	// are the same fact — because everything else about the update lives in this block
	// and a reader comparing "which version, from which version" should not have to
	// join two objects to do it.
	Version string `json:"version"`
	// PreviousVersion and VersionChangedAt describe the last version CROSSING this data
	// went through: what it was served by before, and when the change happened. Both are
	// read from runtime.json rather than computed, so they survive restarts and are the
	// same whether the stack is up or down. Empty on data that has only ever known one
	// version.
	//
	// Both names are direction-NEUTRAL on purpose. A crossing is two endpoints and a
	// moment; which way it went is a comparison of the two versions (see crossingPhrase),
	// and a reader that wants to say "Updated to 0.15.0" has to make that comparison
	// rather than assume it. Assuming it is how the text rendering came to greet the
	// documented downgrade recovery — re-install the older build, restore the snapshot —
	// with "updated from 0.15.0".
	PreviousVersion  string `json:"previousVersion"`
	VersionChangedAt string `json:"versionChangedAt"`
}

// URLs are the addresses to hand a person. Local works on this Mac; LAN is what a phone
// or the kiosk tablet needs.
type URLs struct {
	Local string `json:"local"`
	LAN   string `json:"lan"`
	// LANIP is the same address in its always-dependable form — this Mac's IP — whatever
	// form LAN took. It exists so that a client showing "if a device can't find that
	// name, use this instead" never has to work an IP out for itself. Equal to LAN when
	// the address is already an IP, and empty when this Mac is on no network.
	LANIP     string `json:"lanIp"`
	PowerSync string `json:"powersync"`
}

// Supervisor describes the process that owns the children.
type Supervisor struct {
	PID     int  `json:"pid"`
	Running bool `json:"running"`
}

// Service is one row of the table.
type Service struct {
	Name      string `json:"name"`
	State     string `json:"state"`
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	Health    string `json:"health"`
	Restarts  int    `json:"restarts"`
	LastError string `json:"lastError"`
	Log       string `json:"log"`
}

// Backups is what the menu-bar app needs to answer "am I protected?" without opening
// System Health — and, crucially, without the stack being up.
//
// Every field is derived from the backups directory rather than from the backup_runs
// table: the question is asked exactly when the server is stopped, and a status block
// that needed Postgres would go blank at the only moment it mattered. backup_runs is the
// same facts mirrored for the api, which can only be asked when the api is running.
type Backups struct {
	Dir string `json:"dir"`
	// LastBackupAt, LastPath, LastSizeBytes and LastMigration describe the newest
	// routine dump. Pre-migration snapshots are excluded on purpose: a rollback point is
	// not a backup, and counting one would mask a nightly schedule that had stopped.
	LastBackupAt  string `json:"lastBackupAt"`
	LastPath      string `json:"lastPath"`
	LastSizeBytes int64  `json:"lastSizeBytes"`
	LastMigration string `json:"lastMigration"`
	// Count is how many routine dumps retention is currently holding.
	Count int `json:"count"`
	// LastError is the most recent failure, which leaves no dump behind to notice.
	// Cleared by the next success.
	LastError   string `json:"lastError"`
	LastErrorAt string `json:"lastErrorAt"`
	// ScheduleInstalled reports whether the nightly launchd agent is in place.
	ScheduleInstalled bool `json:"scheduleInstalled"`
	// ScheduleAt is the local 24-hour time that agent runs, "HH:MM", read out of the
	// installed plist itself. Empty when nothing is installed — or when the plist is
	// there and unreadable, which is a schedule nobody should be told the time of.
	ScheduleAt string `json:"scheduleAt"`
	// Keep is how many routine dumps retention holds on to: the nightly schedule's own
	// --keep when it backs up this data directory, the runtime's default otherwise.
	Keep int `json:"keep"`
}

// Bonjour is the advertisement on the local network — how a phone that has never been
// told an address finds this Mac (plan §3).
//
// It is reported beside the services rather than as one of them, and deliberately so: a
// household whose Bonjour registration failed still has a working server that every
// browser and every device typing the address in can reach. Nothing here feeds
// DeriveState, and `advertised: false` is never on its own a reason to draw a red icon.
type Bonjour struct {
	// Advertised is true only while the registration is live on the network.
	Advertised bool `json:"advertised"`
	// Name is the instance name other devices see: the household's, or
	// "Waffled on <computer>".
	Name string `json:"name"`
	// Service is the DNS-SD type, constant, and reported even when nothing is
	// advertising so a client has something to look for.
	Service string `json:"service"`
	// Port is the public Caddy port being advertised — the only one another device
	// should reach.
	Port int `json:"port"`
	// Host is the multicast name this Mac answers to. There is no `waffled.local`:
	// devices see this machine's own hostname, which is why discovery exists.
	Host string `json:"host"`
	// Error says why nothing is being advertised, when something went wrong rather than
	// nothing having been asked for.
	Error string `json:"error"`
}

// Report is the whole document.
type Report struct {
	Schema    int    `json:"schema"`
	State     string `json:"state"`
	DataDir   string `json:"dataDir"`
	BundleDir string `json:"bundleDir"`
	// Initialized is true once the data directory holds a database cluster — a fact
	// about the DATA, not about anything running, so it is answered with every service
	// stopped. It exists so the menu-bar app can tell a first run from every later one
	// without stat'ing a layout the runtime owns.
	Initialized bool       `json:"initialized"`
	URLs        URLs       `json:"urls"`
	Ports       Ports      `json:"ports"`
	Versions    Versions   `json:"versions"`
	Bundle      Bundle     `json:"bundle"`
	Supervisor  Supervisor `json:"supervisor"`
	Services    []Service  `json:"services"`
	// Backups and Bonjour are additive: Schema stays at 1 because no existing field
	// changed meaning.
	Backups     Backups `json:"backups"`
	Bonjour     Bonjour `json:"bonjour"`
	LastError   string  `json:"lastError"`
	GeneratedAt string  `json:"generatedAt"`
}

// DeriveState summarises the services into one word for the menu-bar icon.
//
// The interesting case is a service that is stopped while others run: that is a fault
// (unhealthy), not a start still in progress. "Starting" only describes a stack that is
// on its way up — nothing has failed and nothing is running yet beyond the earlier
// services in the dependency order.
func DeriveState(svcs []Service) string {
	if len(svcs) == 0 {
		return StateStopped
	}
	var running, stopped, starting, unhealthy int
	for _, s := range svcs {
		switch s.State {
		case StateRunning:
			running++
		case StateStarting:
			starting++
		case StateUnhealthy:
			unhealthy++
		default:
			stopped++
		}
	}
	switch {
	case unhealthy > 0:
		return StateUnhealthy
	case stopped == len(svcs):
		return StateStopped
	case running == len(svcs):
		return StateRunning
	case starting > 0:
		return StateStarting
	default:
		// Some running, some stopped, nothing actively starting: a service fell over.
		return StateUnhealthy
	}
}

// Stamp fills in the derived fields just before the report is emitted.
func (r *Report) Stamp() {
	r.Schema = Schema
	if r.State == "" {
		r.State = DeriveState(r.Services)
	}
	r.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
}

// Text is the human rendering — what someone sees when they run `status` in Terminal.
func (r *Report) Text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Waffled %s — %s\n", r.Versions.Waffled, r.State)
	fmt.Fprintf(&b, "  data:   %s\n", r.DataDir)
	fmt.Fprintf(&b, "  bundle: %s\n", r.BundleDir)
	if r.Bundle.PreviousVersion != "" {
		fmt.Fprintf(&b, "  %s %s on %s\n",
			r.Bundle.crossingPhrase(), r.Bundle.PreviousVersion, r.Bundle.VersionChangedAt)
	}
	if r.URLs.Local != "" {
		fmt.Fprintf(&b, "  open:   %s\n", r.URLs.Local)
	}
	if r.URLs.LAN != "" {
		fmt.Fprintf(&b, "  on your network: %s\n", r.URLs.LAN)
	}
	switch {
	case r.Bonjour.Advertised:
		fmt.Fprintf(&b, "  bonjour: %q on %s as %s (port %d)\n",
			r.Bonjour.Name, r.Bonjour.Host, r.Bonjour.Service, r.Bonjour.Port)
	case r.Bonjour.Error != "":
		fmt.Fprintf(&b, "  bonjour: not advertising — %s\n", r.Bonjour.Error)
	}
	b.WriteString("\n")
	for _, s := range r.Services {
		pid := "-"
		if s.PID > 0 {
			pid = fmt.Sprintf("%d", s.PID)
		}
		port := "-"
		if s.Port > 0 {
			port = fmt.Sprintf("%d", s.Port)
		}
		health := s.Health
		if health == "" {
			health = "-"
		}
		fmt.Fprintf(&b, "  %-10s %-9s pid %-7s port %-6s %s", s.Name, s.State, pid, port, health)
		if s.Restarts > 0 {
			fmt.Fprintf(&b, "  (restarted %d×)", s.Restarts)
		}
		b.WriteString("\n")
		if s.LastError != "" {
			fmt.Fprintf(&b, "             last error: %s\n", s.LastError)
		}
	}
	if r.LastError != "" {
		fmt.Fprintf(&b, "\n  %s\n", r.LastError)
	}
	if v := r.Versions; v.Node != "" {
		fmt.Fprintf(&b, "\n  node %s · postgres %s · caddy %s · powersync %s · api %s · web %s\n",
			v.Node, v.Postgres, v.Caddy, v.PowerSync, v.API, v.Web)
	}
	return b.String()
}
