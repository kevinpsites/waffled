// Package ports picks and validates the TCP ports the stack listens on.
//
// The scope matters: Caddy binds the wildcard address so other devices on the LAN can
// reach it, while the api, PowerSync and Postgres bind 127.0.0.1 only (the native
// replacement for Compose's private network). Probing the wrong address gives the wrong
// answer — on this dev Mac Docker holds *:8080, which a 127.0.0.1-only probe reports as
// free right up until Caddy fails to bind it.
package ports

import (
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Scope is the address family a service will actually bind.
type Scope int

const (
	// Loopback is 127.0.0.1 only — api, PowerSync, Postgres.
	Loopback Scope = iota
	// Public is the wildcard address — Caddy's two sites.
	Public
)

func (s Scope) host() string {
	if s == Public {
		return ""
	}
	return "127.0.0.1"
}

func (s Scope) String() string {
	if s == Public {
		return "0.0.0.0"
	}
	return "127.0.0.1"
}

// IsFree reports whether a listener could be opened on this port in this scope right now.
// It is inherently racy — something can grab the port between the probe and the real
// bind — so the services also surface their own bind errors.
func IsFree(scope Scope, port int) bool {
	addr := net.JoinHostPort(scope.host(), strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// Pick returns preferred when it is free, else the next free port above it, scanning at
// most window candidates. Ports in `exclude` are skipped even when free, so several
// services chosen in one pass never collide before any of them has bound.
func Pick(scope Scope, preferred, window int, exclude ...int) (int, error) {
	taken := make(map[int]bool, len(exclude))
	for _, p := range exclude {
		taken[p] = true
	}
	for i := 0; i < window; i++ {
		candidate := preferred + i
		if candidate > 65535 {
			break
		}
		if taken[candidate] {
			continue
		}
		if IsFree(scope, candidate) {
			return candidate, nil
		}
	}
	return 0, ErrNoFreePort(scope, preferred, window)
}

// ErrNoFreePort is the error Pick returns when a scan window is exhausted. It is
// exported so a caller that runs its own scan — with an injected freeness test, to keep
// allocation testable — reports failure in exactly the same words.
func ErrNoFreePort(scope Scope, preferred, window int) error {
	return fmt.Errorf("no free %s port in %d..%d", scope, preferred, preferred+window-1)
}

// VerifyAvailable is the check for a port persisted in runtime.json. A port we chose on
// a previous run and that something else now holds is a hard error, not a cue to move:
// the public port is baked into every phone and tablet that has ever paired.
func VerifyAvailable(scope Scope, port int) error {
	if IsFree(scope, port) {
		return nil
	}
	holder := DescribeHolder(port)
	if holder != "" {
		return fmt.Errorf("port %d (%s) is held by %s", port, scope, holder)
	}
	return fmt.Errorf("port %d (%s) is already in use", port, scope)
}

// DescribeHolder is a best-effort "who has this port" for error messages and `doctor`.
// It shells out to lsof, which is in the macOS base system; anything unexpected yields
// an empty string rather than an error, because this is only ever decoration.
func DescribeHolder(port int) string {
	cmd := exec.Command("lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN")
	out, err := runWithTimeout(cmd, 3*time.Second)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return ""
	}
	fields := strings.Fields(lines[1])
	if len(fields) < 2 {
		return ""
	}
	return fmt.Sprintf("%s (pid %s)", fields[0], fields[1])
}

func runWithTimeout(cmd *exec.Cmd, d time.Duration) ([]byte, error) {
	done := make(chan struct{})
	var out []byte
	var err error
	go func() {
		out, err = cmd.Output()
		close(done)
	}()
	select {
	case <-done:
		return out, err
	case <-time.After(d):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		return nil, fmt.Errorf("timed out")
	}
}
