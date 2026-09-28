// Package bonjour describes the advertisement the runtime puts on the local network:
// what the service is called, what its TXT record says, and the argv that registers it.
//
// It is deliberately pure. The advertisement is a published contract — the iOS "Find
// your Waffled server" screen (plan §7 Phase 4) parses these TXT keys — so the part that
// is easy to get subtly wrong (which name wins, what `setup` means, byte limits on the
// wire) is under fast unit tests, and internal/supervisor worries about the process.
//
// Registration goes through the system mDNSResponder via /usr/bin/dns-sd rather than a
// Go mDNS library on purpose: a second responder bound to 5353 beside mDNSResponder is
// the classic macOS flake, and dns-sd deregisters the moment it is killed.
package bonjour

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// ServiceType is the DNS-SD service the whole household ecosystem looks for.
const ServiceType = "_waffled._tcp"

// TXTVersion is the `txtvers` key every DNS-SD TXT record starts with. A consumer that
// finds a number it does not know should ignore the record rather than guess.
const TXTVersion = "1"

const (
	// MaxInstanceNameBytes is the DNS-SD limit on a service instance name: 63 bytes of
	// UTF-8, not 63 characters.
	MaxInstanceNameBytes = 63
	// MaxTXTEntryBytes is the limit on one length-prefixed TXT string.
	MaxTXTEntryBytes = 255
)

// The fallback name, for an install whose household cannot name itself: the machine's,
// or bare product name on a machine with no name at all.
const (
	productName    = "Waffled"
	fallbackPrefix = productName + " on "
)

// Census is what the database says about this install: how many households exist and,
// when there is exactly one, its name.
//
// Known is false when the database could not be asked at all — a different thing from
// zero households, and the reason `setup=1` is only ever advertised on a positive read
// of an empty install. Telling a phone to "finish setup on your Mac" because psql was
// busy would send someone to re-run a wizard they already completed.
type Census struct {
	Known bool
	Count int
	Name  string
}

// Advertise turns the census and this machine's name into the instance name to publish
// and the value of the `setup` flag.
//
// The machine's name arrives as a callback rather than a string because asking for it
// costs a subprocess (scutil, with a timeout) and a settled install never uses the answer
// — the household names itself. Nil is allowed, and means this machine has no name to
// offer.
func (c Census) Advertise(computerName func() string) (name string, setup bool) {
	if c.Known && c.Count == 1 {
		if household := strings.TrimSpace(c.Name); household != "" {
			return truncate(household, MaxInstanceNameBytes), false
		}
	}
	fallback := productName
	if computerName != nil {
		if machine := strings.TrimSpace(computerName()); machine != "" {
			fallback = fallbackPrefix + machine
		}
	}
	return truncate(fallback, MaxInstanceNameBytes), c.Known && c.Count == 0
}

// Instance is one advertisement: the name on the network and everything the TXT record
// tells a device that finds it.
type Instance struct {
	// Name is the instance name — the household's, or "Waffled on <computer>".
	Name string
	// Port is the PUBLIC Caddy port. It is the only port another device should reach:
	// the api, PowerSync's own listener and Postgres are loopback concerns.
	Port int
	// URL is the address a device should open — the LAN URL, or the .local hostname
	// when this Mac has no routable address.
	URL string
	// Version is the bundle's Waffled version, so a client can refuse a server too old
	// to talk to.
	Version string
	// Setup reports an install with no household yet, so a phone that finds it can say
	// "finish setup on your Mac" instead of offering to sign in.
	Setup bool
}

// TXT is the record's key=value strings, txtvers first by convention.
//
// This list is the contract. Keys are added, never renamed or repurposed — a shipped
// iOS build will be parsing them long after this runtime has moved on.
func (i Instance) TXT() []string {
	setup := "0"
	if i.Setup {
		setup = "1"
	}
	pairs := [][2]string{
		{"txtvers", TXTVersion},
		{"name", i.Name},
		{"url", i.URL},
		{"port", strconv.Itoa(i.Port)},
		{"version", i.Version},
		{"setup", setup},
	}
	out := make([]string, 0, len(pairs))
	for _, p := range pairs {
		key := p[0]
		// The key and the '=' are part of the 255 bytes, so the value gets what is left.
		out = append(out, key+"="+truncate(p[1], MaxTXTEntryBytes-len(key)-1))
	}
	return out
}

// Args is the argv that registers this instance, including argv[0]. An empty tool means
// the platform has no dns-sd (see tool_other.go), and there is nothing to run.
//
// Nothing here is quoted or escaped: these strings go to execve as separate arguments,
// so a household called "Kevin's Home" travels as one argument containing real spaces.
// Escaping it for a shell that is never involved would advertise the backslashes.
func (i Instance) Args(tool string) []string {
	if tool == "" {
		return nil
	}
	args := []string{tool, "-R", i.Name, ServiceType, ".", strconv.Itoa(i.Port)}
	return append(args, i.TXT()...)
}

// NameAndPort reads an instance back out of the argv Args built. It exists for one
// caller: the supervisor recording WHY the advertiser died at a moment when the file that
// held the name and port is missing, leaving the dying child's own command line as the
// last place either survives.
//
// It lives here, immediately below its inverse, because it is the only positional
// knowledge of that command line outside Args itself — kept together, the two are edited
// together, and a round-trip test holds them to it. It reports ok=false for anything that
// is not one of our own registrations rather than guessing: an argv it cannot read leaves
// the supervisor writing an anonymous failure, which is honest, where a misread one would
// put a service type or a flag where a household name belongs.
func NameAndPort(args []string) (string, int, bool) {
	// tool -R <name> <type> . <port>
	const (
		verb = 1
		name = 2
		typ  = 3
		port = 5
	)
	if len(args) <= port || args[verb] != "-R" || args[typ] != ServiceType {
		return "", 0, false
	}
	p, err := strconv.Atoi(args[port])
	if err != nil {
		return "", 0, false
	}
	return args[name], p, true
}

// Host is the multicast name other devices resolve this Mac by. Note what it is NOT:
// there is no `waffled.local` — devices see this machine's own hostname, which is why
// discovery exists at all (plan §3).
func Host(hostname string) string {
	h := strings.TrimSuffix(strings.TrimSpace(hostname), ".")
	if h == "" {
		return ""
	}
	if strings.HasSuffix(h, ".local") {
		return h
	}
	return h + ".local"
}

// truncate cuts to a byte budget without splitting a rune. Household names are typed by
// people, and a name cut mid-rune would put invalid UTF-8 on the wire.
func truncate(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
