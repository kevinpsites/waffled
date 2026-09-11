package supervisor

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
)

// The address other devices in the house use, and the port it is on, both live in
// config.env so a person can set them from the Mac app's setup screen or by hand.
//
// There is no TLS here. Waffled serves plain HTTP on the household's own network; a
// custom name buys a nicer address, not a certificate.
const (
	// KeyPublicHost is WAFFLED_PUBLIC_HOST: empty, one of the two reserved words below,
	// or a hostname the household has pointed at this Mac.
	KeyPublicHost = "WAFFLED_PUBLIC_HOST"
	// KeyHTTPPort is HTTP_PORT: the *preferred* public port. A busy one falls forward,
	// which is why this is a preference and not a requirement.
	KeyHTTPPort = "HTTP_PORT"

	// PublicHostIP asks for this Mac's address on the network — the dependable form, for
	// the networks where a `.local` name does not resolve.
	PublicHostIP = "ip"
	// PublicHostName asks for this Mac's own multicast name, `<hostname>.local`, which
	// is what Bonjour advertises.
	PublicHostName = "name"
)

// publicURL composes the address to hand a phone or the kiosk tablet.
//
// Empty means "there is nothing honest to show": no network, no multicast name, no port
// yet. Every caller treats that the way LANURL always has — say nothing rather than
// print a localhost that only ever works on this Mac.
func publicURL(publicHost, lanIP, bonjourHost string, port int) string {
	if port <= 0 {
		return ""
	}
	host := strings.TrimSpace(publicHost)
	switch strings.ToLower(host) {
	// Empty is an install from before this setting existed. It keeps the address it has
	// always had; the Mac app writes the choice out explicitly, so nothing a household
	// has already handed round changes underneath them.
	case "", PublicHostIP:
		host = lanIP
	case PublicHostName:
		// The IP when this Mac has no usable multicast name: the alternative is a ready
		// step with no address on it and a QR code that never renders.
		host = bonjourHost
		if host == "" {
			host = lanIP
		}
	default:
		if !isHostname(host) {
			return ""
		}
	}
	if host == "" {
		return ""
	}
	return "http://" + host + ":" + strconv.Itoa(port)
}

// isHostname rejects what a paste produces — a scheme, a port, a path, a space — rather
// than composing an address no device could reach and saying nothing about it.
func isHostname(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-' || c == '.':
		default:
			return false
		}
	}
	// A leading or trailing dot, or an empty label, is not a name either.
	return !strings.HasPrefix(s, ".") && !strings.HasSuffix(s, ".") && !strings.Contains(s, "..")
}

// preferredPublicPort reads HTTP_PORT, which is the port a household would like Caddy's
// public site on. It is only a preference: choosePorts falls forward from it.
func preferredPublicPort(env *configenv.Env) (int, error) {
	raw := env.Get(KeyHTTPPort)
	if raw == "" {
		return DefaultPublicPort, nil
	}
	// Not TrimSpace'd: config.env is written by `config set`, and a value with spaces
	// round it is a hand-edit worth reporting rather than quietly interpreting.
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s=%q is not a port between 1 and 65535", KeyHTTPPort, raw)
	}
	return port, nil
}
