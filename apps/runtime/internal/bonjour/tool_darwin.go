//go:build darwin

package bonjour

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// tool is the system DNS-SD client. It ships with macOS, talks to the mDNSResponder
// everything else on the Mac already uses, and withdraws the registration when it dies —
// which is exactly the lifetime we want, since it is supervised as a child.
const tool = "/usr/bin/dns-sd"

// Tool is the dns-sd binary to run, or "" when this platform cannot advertise.
func Tool() string {
	if _, err := os.Stat(tool); err != nil {
		return ""
	}
	return tool
}

// ComputerName is what the Mac calls itself in Sharing preferences — "Kevin's MacBook
// Pro", not the DNS-safe "Kevins-MacBook-Pro". It is the friendlier half of "Waffled on
// <computer>", so it is worth one short subprocess at start; the hostname is the
// fallback when scutil is unavailable or slow.
func ComputerName() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--get", "ComputerName").Output(); err == nil {
		if name := strings.TrimSpace(string(out)); name != "" {
			return name
		}
	}
	return hostnameFallback()
}

func hostnameFallback() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(strings.TrimSpace(h), ".local")
}
