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

// Bundle identifies the build the data is being served by.
type Bundle struct {
	GitSha   string `json:"gitSha"`
	BuiltAt  string `json:"builtAt"`
	Arch     string `json:"arch"`
	Platform string `json:"platform"`
	Verified bool   `json:"verified"`
}

// URLs are the addresses to hand a person. Local works on this Mac; LAN is what a phone
// or the kiosk tablet needs.
type URLs struct {
	Local     string `json:"local"`
	LAN       string `json:"lan"`
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

// Report is the whole document.
type Report struct {
	Schema      int        `json:"schema"`
	State       string     `json:"state"`
	DataDir     string     `json:"dataDir"`
	BundleDir   string     `json:"bundleDir"`
	URLs        URLs       `json:"urls"`
	Ports       Ports      `json:"ports"`
	Versions    Versions   `json:"versions"`
	Bundle      Bundle     `json:"bundle"`
	Supervisor  Supervisor `json:"supervisor"`
	Services    []Service  `json:"services"`
	LastError   string     `json:"lastError"`
	GeneratedAt string     `json:"generatedAt"`
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
	if r.URLs.Local != "" {
		fmt.Fprintf(&b, "  open:   %s\n", r.URLs.Local)
	}
	if r.URLs.LAN != "" {
		fmt.Fprintf(&b, "  on your network: %s\n", r.URLs.LAN)
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
