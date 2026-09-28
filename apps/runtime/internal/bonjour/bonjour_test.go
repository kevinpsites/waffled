package bonjour

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// machine stands in for the callback that asks this Mac its name.
func machine(name string) func() string { return func() string { return name } }

func TestCensusPicksTheHouseholdNameWhenThereIsExactlyOne(t *testing.T) {
	name, setup := Census{Known: true, Count: 1, Name: "The Seinfelds"}.Advertise(machine("Kevin’s MacBook Pro"))
	if name != "The Seinfelds" {
		t.Errorf("name = %q, want the household name", name)
	}
	if setup {
		t.Error("setup = true, but this install has a household")
	}
}

func TestCensusFallsBackToTheComputerName(t *testing.T) {
	cases := []struct {
		what      string
		census    Census
		wantSetup bool
	}{
		// Zero households is the only case that means "finish setup on your Mac".
		{"before setup", Census{Known: true, Count: 0}, true},
		// More than one household: no single name is the household's name.
		{"several households", Census{Known: true, Count: 3, Name: "The Seinfelds"}, false},
		// The database could not be asked. Not the same as zero: a phone must not be
		// told to run setup because psql happened to be busy.
		{"database unavailable", Census{}, false},
		// A household with a blank name is not a name to advertise.
		{"a blank household name", Census{Known: true, Count: 1, Name: "   "}, false},
	}
	for _, tc := range cases {
		t.Run(tc.what, func(t *testing.T) {
			name, setup := tc.census.Advertise(machine("Kevin’s MacBook Pro"))
			if name != "Waffled on Kevin’s MacBook Pro" {
				t.Errorf("name = %q, want the computer-name fallback", name)
			}
			if setup != tc.wantSetup {
				t.Errorf("setup = %v, want %v", setup, tc.wantSetup)
			}
		})
	}
}

func TestCensusSurvivesAnEmptyComputerName(t *testing.T) {
	name, _ := Census{}.Advertise(machine("  "))
	if name != "Waffled" {
		t.Errorf("name = %q, want plain %q when the machine has no name", name, "Waffled")
	}
}

// A DNS-SD instance name is at most 63 BYTES, and the household name is whatever a
// person typed. Cutting mid-rune would put an invalid UTF-8 sequence on the wire.
func TestInstanceNameIsTruncatedOnARuneBoundary(t *testing.T) {
	long := strings.Repeat("é", 100) // 200 bytes
	name, _ := Census{Known: true, Count: 1, Name: long}.Advertise(machine("mac"))
	if len(name) > MaxInstanceNameBytes {
		t.Errorf("name is %d bytes, want at most %d", len(name), MaxInstanceNameBytes)
	}
	if !utf8.ValidString(name) {
		t.Errorf("name %q is not valid UTF-8", name)
	}
	if !strings.HasPrefix(long, name) {
		t.Errorf("name %q is not a prefix of the household name", name)
	}
}

func txtMap(t *testing.T, entries []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, e := range entries {
		k, v, ok := strings.Cut(e, "=")
		if !ok {
			t.Fatalf("TXT entry %q has no '='", e)
		}
		out[k] = v
	}
	return out
}

func TestTXTCarriesTheContractTheIOSAppParses(t *testing.T) {
	inst := Instance{
		Name:    "The Seinfelds",
		Port:    8080,
		URL:     "http://192.168.1.5:8080",
		Version: "0.14.3",
		Setup:   false,
	}
	entries := inst.TXT()
	if entries[0] != "txtvers=1" {
		t.Errorf("first TXT entry = %q, want txtvers=1", entries[0])
	}
	got := txtMap(t, entries)
	want := map[string]string{
		"txtvers": "1",
		"name":    "The Seinfelds",
		"url":     "http://192.168.1.5:8080",
		"port":    "8080",
		"version": "0.14.3",
		"setup":   "0",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("TXT %s = %q, want %q", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("TXT has %d keys (%v), want exactly %d", len(got), entries, len(want))
	}
}

func TestTXTSetupIsOneBeforeSetup(t *testing.T) {
	got := txtMap(t, Instance{Name: "Waffled on mac", Setup: true}.TXT())
	if got["setup"] != "1" {
		t.Errorf("setup = %q, want 1", got["setup"])
	}
}

// Each key=value string must fit one DNS TXT string: 255 bytes, length-prefixed.
func TestTXTEntriesAreTruncatedToTheWireLimit(t *testing.T) {
	inst := Instance{Name: strings.Repeat("é", 400), Port: 8080}
	for _, e := range inst.TXT() {
		if len(e) > MaxTXTEntryBytes {
			t.Errorf("TXT entry is %d bytes, want at most %d: %q", len(e), MaxTXTEntryBytes, e)
		}
		if !utf8.ValidString(e) {
			t.Errorf("TXT entry %q is not valid UTF-8", e)
		}
	}
}

// The values travel as argv, straight to execve — no shell. A name with spaces is ONE
// argument with real spaces in it; escaping it here would advertise the backslashes.
func TestArgsPassValuesUnescapedAsSingleArguments(t *testing.T) {
	inst := Instance{Name: "Kevin’s Home", Port: 8080, URL: "http://192.168.1.5:8080", Version: "0.14.3"}
	args := inst.Args("/usr/bin/dns-sd")

	want := []string{"/usr/bin/dns-sd", "-R", "Kevin’s Home", ServiceType, ".", "8080"}
	for i, w := range want {
		if i >= len(args) || args[i] != w {
			t.Fatalf("args = %q, want it to start with %q", args, want)
		}
	}
	entries := txtMap(t, args[len(want):])
	if entries["name"] != "Kevin’s Home" {
		t.Errorf("the name TXT entry = %q, want it unescaped", entries["name"])
	}
	for _, a := range args {
		if strings.Contains(a, `\`) {
			t.Errorf("argv element %q contains a backslash — argv is not shell-quoted", a)
		}
	}
}

// The no-op sibling: on a platform with no dns-sd there is nothing to run, and the
// caller must get nothing rather than a command with an empty path.
func TestArgsAreNilWithoutATool(t *testing.T) {
	if args := (Instance{Name: "x", Port: 1}).Args(""); args != nil {
		t.Errorf("args = %q, want nil when the platform has no dns-sd", args)
	}
}

// NameAndPort is Args read backwards, and it lives beside Args so the two are edited
// together: the supervisor uses it to say what was being advertised when the record of
// it has been lost, and a positional reader that silently drifted from the writer would
// put a service type where a household name belongs.
func TestNameAndPortReadsBackWhatArgsWrote(t *testing.T) {
	inst := Instance{Name: "Kevin’s Home", Port: 8080, URL: "http://192.168.1.5:8080", Version: "0.14.3"}
	name, port, ok := NameAndPort(inst.Args("/usr/bin/dns-sd"))
	if !ok {
		t.Fatal("the argv this package just built did not read back")
	}
	if name != inst.Name || port != inst.Port {
		t.Errorf("read back %q port %d, want %q port %d", name, port, inst.Name, inst.Port)
	}

	// Anything that is not one of our own registrations is "cannot say" rather than a
	// guess: a wrong name in bonjour.json is worse than an anonymous failure.
	for _, args := range [][]string{
		nil,
		{"/usr/bin/dns-sd"},
		{"/usr/bin/dns-sd", "-B", ServiceType, "."},                       // a browse, not a registration
		{"/usr/bin/dns-sd", "-R", "Home", ServiceType, "."},               // truncated before the port
		{"/usr/bin/dns-sd", "-R", "Home", ServiceType, ".", "not-a-port"}, // unparseable port
		{"/usr/bin/dns-sd", "-R", "Home", "_other._tcp", ".", "8080"},     // somebody else's service
	} {
		if name, port, ok := NameAndPort(args); ok {
			t.Errorf("NameAndPort(%q) = %q, %d, true — want it to decline", args, name, port)
		}
	}
}

func TestHostAlwaysNamesTheMulticastDomain(t *testing.T) {
	cases := map[string]string{
		"Kevins-MacBook-Pro.local":  "Kevins-MacBook-Pro.local",
		"Kevins-MacBook-Pro.local.": "Kevins-MacBook-Pro.local",
		"kevins-mac-mini":           "kevins-mac-mini.local",
		"":                          "",
	}
	for in, want := range cases {
		if got := Host(in); got != want {
			t.Errorf("Host(%q) = %q, want %q", in, got, want)
		}
	}
}

// Asking the Mac its name means forking scutil with a three-second timeout, and a settled
// install never uses the answer: the household names itself. So the question is asked
// only where it is needed, not on every advertisement.
func TestASettledCensusNeverAsksForTheComputerName(t *testing.T) {
	asked := 0
	counted := func() string {
		asked++
		return "Kevin’s MacBook Pro"
	}
	if name, _ := (Census{Known: true, Count: 1, Name: "The Seinfelds"}).Advertise(counted); name != "The Seinfelds" {
		t.Fatalf("name = %q", name)
	}
	if asked != 0 {
		t.Errorf("the computer name was asked for %d times by a census that cannot use it", asked)
	}
	// The fallback still gets it.
	if name, _ := (Census{Known: true, Count: 0}).Advertise(counted); name != "Waffled on Kevin’s MacBook Pro" {
		t.Errorf("name = %q, want the machine fallback", name)
	}
	if asked != 1 {
		t.Errorf("the fallback asked for the computer name %d times, want once", asked)
	}
}

// A caller with nothing to offer must still get a name.
func TestCensusSurvivesNoComputerNameCallback(t *testing.T) {
	if name, _ := (Census{}).Advertise(nil); name != "Waffled" {
		t.Errorf("name = %q, want the bare product name", name)
	}
}
