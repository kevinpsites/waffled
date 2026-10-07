package ports

import (
	"fmt"
	"net"
	"strings"
	"testing"
)

// occupy binds a port on the given host for the duration of the test and returns it.
func occupy(t *testing.T, host string) int {
	t.Helper()
	ln, err := net.Listen("tcp", host+":0")
	if err != nil {
		t.Fatalf("could not occupy a port: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func TestFreeReportsAnOccupiedPortAsTaken(t *testing.T) {
	p := occupy(t, "127.0.0.1")
	if IsFree(Loopback, p) {
		t.Errorf("port %d is bound on 127.0.0.1 but IsFree said it was free", p)
	}
}

// A public port is bound wildcard, so probing only 127.0.0.1 would wrongly call it free
// on the dev Mac where Docker holds *:8080. Public probes must use the wildcard address.
func TestPublicProbeSeesAWildcardBinding(t *testing.T) {
	p := occupy(t, "")
	if IsFree(Public, p) {
		t.Errorf("port %d is bound on 0.0.0.0 but IsFree(Public) said it was free", p)
	}
}

func TestPickFallsForwardPastAnOccupiedPort(t *testing.T) {
	p := occupy(t, "127.0.0.1")
	got, err := Pick(Loopback, p, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got == p {
		t.Fatalf("Pick returned the occupied port %d", got)
	}
	if got <= p {
		t.Fatalf("Pick(%d) must scan forward, got %d", p, got)
	}
	if !IsFree(Loopback, got) {
		t.Fatalf("Pick returned %d which is not free", got)
	}
}

func TestPickReturnsThePreferredPortWhenItIsFree(t *testing.T) {
	p := occupy(t, "127.0.0.1")
	// Re-derive a definitely-free port by closing nothing: pick from p+1 upward.
	got, err := Pick(Loopback, p+1, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got != p+1 && !IsFree(Loopback, p+1) {
		t.Skip("the port right after the occupied one was itself taken by another process")
	}
	if got != p+1 {
		t.Fatalf("Pick should have returned the free preferred port %d, got %d", p+1, got)
	}
}

func TestPickGivesUpAfterTheScanWindow(t *testing.T) {
	// A window of zero candidates can never succeed and must report which range it tried.
	_, err := Pick(Loopback, 65535, 0)
	if err == nil {
		t.Fatal("expected an error when the scan window is empty")
	}
	if !strings.Contains(err.Error(), "65535") {
		t.Errorf("the error should name the range it tried, got %q", err)
	}
}

func TestAllocateSkipsPortsAlreadyChosenInTheSameRun(t *testing.T) {
	// Two services whose defaults collide must not be handed the same port, even though
	// neither is bound yet at selection time.
	a := occupy(t, "127.0.0.1")
	first, err := Pick(Loopback, a, 50)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Pick(Loopback, a, 50, first)
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatalf("Pick handed out %d twice", first)
	}
}

func TestDescribeHolderIsBestEffortAndNeverPanics(t *testing.T) {
	p := occupy(t, "127.0.0.1")
	// We only require a non-panicking string; the content depends on lsof being present.
	_ = DescribeHolder(p)
	if IsFree(Loopback, p) {
		t.Fatal("sanity: the port should still be held")
	}
}

func TestVerifyHeldPortRejectsAStranger(t *testing.T) {
	p := occupy(t, "127.0.0.1")
	err := VerifyAvailable(Loopback, p)
	if err == nil {
		t.Fatalf("a persisted port now held by something else must fail loudly")
	}
	if !strings.Contains(err.Error(), fmt.Sprint(p)) {
		t.Errorf("the error should name the port, got %q", err)
	}
}
