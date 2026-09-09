//go:build integration

// Bonjour, against the real bundle: the stack advertises itself on the local network
// while it is up, and stops advertising when it comes down.
//
//	WAFFLED_BUNDLE=/path/to/runtime go test -tags integration -run Bonjour ./...
package runtime_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

func TestTheStackAdvertisesItselfOnBonjour(t *testing.T) {
	bundle := bundleDir(t)
	data := dataDir(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	s := newSupervisor(t, bundle, data)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer stopCancel()
		if err := s.Stop(stopCtx); err != nil {
			t.Errorf("cleanup stop: %v", err)
		}
		killLeftovers(t, data)
	})

	if err := s.Start(ctx); err != nil {
		dumpLogs(t, data)
		t.Fatalf("start: %v", err)
	}
	public := s.Plan().Ports.Public

	// ── what this Mac says it is doing ──────────────────────────────────────────
	report := s.Status(ctx)
	b := report.Bonjour
	if !b.Advertised {
		dumpLogs(t, data)
		t.Fatalf("nothing is being advertised: %+v", b)
	}
	if b.Error != "" {
		t.Errorf("advertised, but with an error recorded: %s", b.Error)
	}
	if b.Service != bonjour.ServiceType {
		t.Errorf("service = %q, want %q", b.Service, bonjour.ServiceType)
	}
	if b.Port != public {
		t.Errorf("advertised port = %d, want the public Caddy port %d", b.Port, public)
	}
	if !strings.HasSuffix(b.Host, ".local") {
		t.Errorf("host = %q, want a .local name", b.Host)
	}
	// A fresh data directory has no household, so the name is the machine fallback.
	if !strings.HasPrefix(b.Name, "Waffled on ") {
		t.Errorf("name = %q, want the %q fallback on an install with no household", b.Name, "Waffled on …")
	}

	// The advertiser is a real supervised process with a pidfile, like the others…
	layout := datadir.At(data)
	pid := readPid(t, layout.PidPath("bonjour"))
	if !alive(pid) {
		t.Errorf("the dns-sd child (pid %d) is not running", pid)
	}
	// …and yet it is NOT one of the server's services: it must not appear in the array
	// the menu-bar app renders as rows, and it must not touch the overall state.
	if len(report.Services) != 4 {
		t.Errorf("expected the same four services, got %d", len(report.Services))
	}
	for _, svc := range report.Services {
		if svc.Name == "bonjour" {
			t.Error("bonjour is in the services array — a failed advertisement would then look like a broken server")
		}
	}
	if report.State != status.StateRunning {
		t.Errorf("state = %q, want running", report.State)
	}

	// ── what the network can actually see ───────────────────────────────────────
	t.Run("the registration answers a browse", func(t *testing.T) {
		zone := browseZone(t, 4*time.Second)
		if !strings.Contains(zone, bonjour.ServiceType) {
			t.Skipf("no %s instance was visible at all — mDNSResponder or multicast is "+
				"unavailable on this host, so only the child lifecycle was checked", bonjour.ServiceType)
		}
		// Matched by PORT, never by name: this Mac may already run a real Waffled, and
		// mDNSResponder renames a colliding instance rather than refusing it. The port
		// was chosen free for this test, so it is what identifies us.
		txt, ok := txtForPort(zone, public)
		if !ok {
			t.Fatalf("no advertised instance on port %d:\n%s", public, zone)
		}
		want := map[string]string{
			"txtvers": "1",
			"name":    b.Name,
			"port":    strconv.Itoa(public),
			"version": report.Versions.Waffled,
			// An empty install: the phone that finds this should offer to finish setup.
			"setup": "1",
		}
		for k, v := range want {
			if txt[k] != v {
				t.Errorf("TXT %s = %q, want %q (whole record: %v)", k, txt[k], v, txt)
			}
		}
		if url := txt["url"]; !strings.HasSuffix(url, ":"+strconv.Itoa(public)) {
			t.Errorf("TXT url = %q, want an address on the public port %d", url, public)
		}
		if len(txt) != 6 {
			t.Errorf("the TXT record has %d keys, want the documented six: %v", len(txt), txt)
		}
	})

	// ── and it goes away ────────────────────────────────────────────────────────
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer stopCancel()
	if err := s.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if alive(pid) {
		t.Errorf("the dns-sd child (pid %d) is still running after stop — the household would "+
			"still be advertised by a server that is down", pid)
	}
	if _, err := os.Stat(layout.BonjourState); !os.IsNotExist(err) {
		t.Errorf("%s survived the stop", layout.BonjourState)
	}
	if after := s.Status(stopCtx).Bonjour; after.Advertised || after.Name != "" {
		t.Errorf("status still reports an advertisement after stop: %+v", after)
	}
	if zone := browseZone(t, 3*time.Second); strings.Contains(zone, bonjour.ServiceType) {
		if _, ok := txtForPort(zone, public); ok {
			t.Errorf("the instance on port %d is still on the network after stop:\n%s", public, zone)
		}
	}
}

// browseZone dumps every advertised instance of our service type in zone-file form: one
// SRV line carrying the port and one TXT line per instance.
//
// `-t` rather than a killed context, deliberately: dns-sd block-buffers its stdout down
// a pipe, so a browse that ends by being killed comes back empty and this test would
// "prove" the Mac was not advertising.
func browseZone(t *testing.T, timeout time.Duration) string {
	t.Helper()
	tool := bonjour.Tool()
	if tool == "" {
		t.Skip("no dns-sd client on this platform")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout+5*time.Second)
	defer cancel()
	seconds := strconv.Itoa(int(timeout / time.Second))
	out, err := exec.CommandContext(ctx, tool, "-t", seconds, "-Z", bonjour.ServiceType, ".").Output()
	if err != nil {
		t.Skipf("could not browse the network (%v) — only the child lifecycle was checked", err)
	}
	t.Logf("dns-sd -Z %s:\n%s", bonjour.ServiceType, out)
	return string(out)
}

// txtForPort finds the instance whose SRV record names port and returns its TXT record.
//
//	<instance> SRV 0 0 8082 Kevins-MacBook-Pro.local. ; …
//	<instance> TXT "txtvers=1" "name=The Seinfelds" …
func txtForPort(zone string, port int) (map[string]string, bool) {
	want := strconv.Itoa(port)
	instance := ""
	for _, line := range strings.Split(zone, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 6 && fields[1] == "SRV" && fields[4] == want {
			instance = fields[0]
			break
		}
	}
	if instance == "" {
		return nil, false
	}
	for _, line := range strings.Split(zone, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != instance || fields[1] != "TXT" {
			continue
		}
		txt := map[string]string{}
		for _, entry := range quotedFields(strings.TrimSpace(strings.SplitN(line, "TXT", 2)[1])) {
			if k, v, ok := strings.Cut(entry, "="); ok {
				txt[k] = v
			}
		}
		return txt, true
	}
	return nil, false
}

// quotedFields splits `"a=1" "b=two words"` into its quoted strings.
func quotedFields(s string) []string {
	var out []string
	for {
		start := strings.Index(s, `"`)
		if start < 0 {
			return out
		}
		rest := s[start+1:]
		end := strings.Index(rest, `"`)
		if end < 0 {
			return out
		}
		out = append(out, rest[:end])
		s = rest[end+1:]
	}
}

func readPid(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("%s does not contain a pid: %v", path, err)
	}
	return pid
}

// alive asks whether a pid exists. Signal 0 performs the existence and permission
// checks without delivering anything — os.Signal(nil) does NOT: it fails the type
// assertion inside os.Process.Signal and reports every process as dead.
func alive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
