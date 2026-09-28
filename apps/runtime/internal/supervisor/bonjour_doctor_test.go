package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Real `dns-sd -B _waffled._tcp .` output, one Add line per interface.
const browseOutput = `Browsing for _waffled._tcp
DATE: ---Tue 08 Sep 2026---
16:19:25.646  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
16:19:26.847  Add        3   1 local.               _waffled._tcp.       The Seinfelds
16:19:26.847  Add        2  14 local.               _waffled._tcp.       The Seinfelds
`

func TestBrowseOutputFindsOurInstance(t *testing.T) {
	if !instanceSeen(browseOutput, "The Seinfelds") {
		t.Error("our own instance was not found in a browse that lists it")
	}
	if instanceSeen(browseOutput, "The Costanzas") {
		t.Error("a different household's instance was matched")
	}
	// mDNSResponder renames on a name collision, and the renamed instance is still ours
	// — the household should not be told discovery is broken because a neighbour got
	// there first.
	renamed := strings.ReplaceAll(browseOutput, "The Seinfelds", "The Seinfelds (2)")
	if !instanceSeen(renamed, "The Seinfelds") {
		t.Error("an instance renamed by mDNSResponder on a collision was not recognised")
	}
	// But a neighbour whose household name merely STARTS with ours is somebody else's
	// advertisement, and counting it would report "discoverable" while this Mac's own
	// registration is blocked — a false pass hiding the real fault.
	neighbour := strings.ReplaceAll(browseOutput, "The Seinfelds", "The Seinfelds Next Door")
	if instanceSeen(neighbour, "The Seinfelds") {
		t.Error("a different household whose name starts with ours was matched")
	}
	if instanceSeen(strings.ReplaceAll(browseOutput, "The Seinfelds", "Smith Family"), "Smith") {
		t.Error(`"Smith Family" was matched for the household "Smith"`)
	}
	// A browse that saw nothing, and a removal, are both "not there".
	if instanceSeen("Browsing for _waffled._tcp\n...STARTING...\n", "The Seinfelds") {
		t.Error("an empty browse reported an instance")
	}
	if instanceSeen(strings.ReplaceAll(browseOutput, "Add ", "Rmv "), "The Seinfelds") {
		t.Error("a withdrawn registration was reported as present")
	}
}

// dns-sd -B browses forever, and its stdout is block-buffered down a pipe: a browse that
// ends by being killed comes back EMPTY, which would report an empty network on a Mac
// that is advertising fine. It has to end by itself, in time, with its output flushed.
func TestBrowseIsBoundedAndReturnsWhatItHeard(t *testing.T) {
	if browseTool() == "" {
		t.Skip("no dns-sd on this platform")
	}
	start := time.Now()
	out, err := browseBonjour(context.Background(), 2*time.Second)
	if err != nil {
		t.Fatalf("browse returned an error for its own deadline: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("browse ran for %s — it is not bounded", elapsed)
	}
	if !strings.Contains(out, "_waffled._tcp") {
		t.Errorf("the browse output was not captured before the deadline killed it:\n%s", out)
	}
}

// A browse we had to kill tells us nothing about the network, and must not be reported as
// one that heard nothing: `doctor` turns an empty result into "check your firewall and the
// Local Network permission", which is the wrong thing to send someone chasing when the
// truth is that the subprocess hung.
func TestABrowseThatRanOutOfTimeIsAnError(t *testing.T) {
	dir := t.TempDir()
	tool := filepath.Join(dir, "dns-sd")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	restore := browseTool
	browseTool = func() string { return tool }
	t.Cleanup(func() { browseTool = restore })

	out, err := browseBonjour(context.Background(), time.Second)
	if err == nil {
		t.Fatalf("a browse that had to be killed was reported as a clean, empty network (out %q)", out)
	}
	if !strings.Contains(err.Error(), "did not finish") {
		t.Errorf("error = %v, want one that says the browse did not finish", err)
	}
}
