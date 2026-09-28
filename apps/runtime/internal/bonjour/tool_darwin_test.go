//go:build darwin

package bonjour

import (
	"os/exec"
	"strings"
	"testing"
)

// The whole design rests on the system client existing on every Mac. If this ever fails
// on a supported OS, the advertiser needs a different implementation, not a workaround.
func TestToolIsTheSystemDNSSDClient(t *testing.T) {
	if Tool() != "/usr/bin/dns-sd" {
		t.Fatalf("Tool() = %q, want the system dns-sd", Tool())
	}
	if _, err := exec.LookPath(Tool()); err != nil {
		t.Fatalf("%s is not executable: %v", Tool(), err)
	}
}

func TestComputerNameIsNotEmpty(t *testing.T) {
	name := ComputerName()
	if strings.TrimSpace(name) == "" {
		t.Fatal("ComputerName() is empty — the fallback should at least give a hostname")
	}
	if strings.HasSuffix(name, ".local") {
		t.Errorf("ComputerName() = %q — the .local suffix belongs to the host name, not the friendly one", name)
	}
}
