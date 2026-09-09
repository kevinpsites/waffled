//go:build !darwin

package bonjour

import (
	"os"
	"strings"
)

// Tool reports that this platform cannot advertise: there is no system DNS-SD client to
// register through, and shipping a second responder on 5353 is exactly what the darwin
// path avoids. The supervisor treats "" as "skip it and say so in `status`" — never as
// an error, because a server that no phone can discover still serves every browser and
// every device typing the address in.
//
// Windows (plan §9) has `dns-sd.exe` only when Bonjour for Windows is installed, and
// Linux would register through Avahi. Both are a later decision; the seam is this file.
func Tool() string { return "" }

// ComputerName is the machine's hostname on a platform with no friendlier name to ask
// for.
func ComputerName() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(strings.TrimSpace(h), ".local")
}
