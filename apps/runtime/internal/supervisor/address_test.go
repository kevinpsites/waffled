package supervisor

import (
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
)

// An install from before this setting existed carries no WAFFLED_PUBLIC_HOST, and must
// go on reporting exactly the address it has always reported: every phone and tablet in
// the household was handed that one, and the menu bar shows it.
func TestNoPublicHostSettingKeepsTheAddressItAlwaysHad(t *testing.T) {
	got := publicURL("", "192.168.1.5", "sam-mac.local", 8082)
	if got != "http://192.168.1.5:8082" {
		t.Errorf("publicURL = %q, want the LAN address", got)
	}
}

func TestPublicHostModes(t *testing.T) {
	for _, c := range []struct {
		name, mode, want string
	}{
		{"an explicit ip is the LAN address", PublicHostIP, "http://192.168.1.5:8082"},
		{"name is this Mac's multicast name", PublicHostName, "http://sam-mac.local:8082"},
		{"anything else is that host, verbatim", "waffled.home", "http://waffled.home:8082"},
		{"surrounding space is not part of a hostname", "  waffled.home  ", "http://waffled.home:8082"},
		{"the reserved words are not case-sensitive", "IP", "http://192.168.1.5:8082"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := publicURL(c.mode, "192.168.1.5", "sam-mac.local", 8082); got != c.want {
				t.Errorf("publicURL(%q) = %q, want %q", c.mode, got, c.want)
			}
		})
	}
}

// Empty rather than a localhost that only ever works on this Mac — the same rule LANURL
// has always followed, so the menu can say "not on a network" instead of showing a lie.
func TestPublicURLIsEmptyWhenThereIsNothingToName(t *testing.T) {
	for _, c := range []struct {
		name, mode, ip, host string
		port                 int
	}{
		{"no LAN address", "", "", "sam-mac.local", 8082},
		{"ip mode with no LAN address", PublicHostIP, "", "sam-mac.local", 8082},
		{"no port yet", "waffled.home", "192.168.1.5", "sam-mac.local", 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := publicURL(c.mode, c.ip, c.host, c.port); got != "" {
				t.Errorf("publicURL = %q, want empty", got)
			}
		})
	}
}

// The setup screen writes `name` for the household that took the default, so a Mac with
// no usable multicast name must not be left with no address at all — the address card and
// the QR code both come from this one string.
func TestNameModeFallsBackToTheAddressThatAlwaysWorks(t *testing.T) {
	if got := publicURL(PublicHostName, "192.168.1.5", "", 8082); got != "http://192.168.1.5:8082" {
		t.Errorf("publicURL = %q, want the LAN address", got)
	}
	if got := publicURL(PublicHostName, "", "", 8082); got != "" {
		t.Errorf("publicURL = %q, want empty — there is nothing honest to show", got)
	}
}

// A host with a scheme, a path or a port in it is a paste, not a hostname, and it would
// produce an address no device could reach — with no error anywhere to say so.
func TestPublicURLRefusesAHostThatIsNotOne(t *testing.T) {
	for _, host := range []string{
		"http://waffled.home", "waffled.home:8080", "waffled.home/app", "waffled home", "waffled.home?x",
	} {
		if got := publicURL(host, "192.168.1.5", "sam-mac.local", 8082); got != "" {
			t.Errorf("publicURL(%q) = %q, want empty — that is not a hostname", host, got)
		}
	}
}

// ── the preferred port ────────────────────────────────────────────────────────

func envWith(t *testing.T, assignments ...string) *configenv.Env {
	t.Helper()
	env, err := configenv.Load(t.TempDir() + "/does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range assignments {
		k, v, _ := cutAssignment(a)
		env.Set(k, v)
	}
	return env
}

func cutAssignment(a string) (string, string, bool) {
	for i := 0; i < len(a); i++ {
		if a[i] == '=' {
			return a[:i], a[i+1:], true
		}
	}
	return a, "", false
}

func TestPreferredPublicPortDefaultsToTheComposeNumber(t *testing.T) {
	port, err := preferredPublicPort(envWith(t))
	if err != nil {
		t.Fatal(err)
	}
	if port != DefaultPublicPort {
		t.Errorf("preferredPublicPort = %d, want %d", port, DefaultPublicPort)
	}
}

func TestPreferredPublicPortReadsHTTPPort(t *testing.T) {
	port, err := preferredPublicPort(envWith(t, "HTTP_PORT=9000"))
	if err != nil {
		t.Fatal(err)
	}
	if port != 9000 {
		t.Errorf("preferredPublicPort = %d, want 9000", port)
	}
}

func TestPreferredPublicPortRefusesWhatCouldNotBeBound(t *testing.T) {
	for _, v := range []string{"0", "-1", "65536", "eighty", "80.5", "8080 "} {
		if port, err := preferredPublicPort(envWith(t, "HTTP_PORT="+v)); err == nil {
			t.Errorf("HTTP_PORT=%q was accepted as %d", v, port)
		}
	}
}

// ── the public port a first run chooses ───────────────────────────────────────

func TestChoosePortsHonoursThePreferredPublicPort(t *testing.T) {
	chosen, err := choosePorts(thisMac(), 9000)
	if err != nil {
		t.Fatal(err)
	}
	if chosen.Public != 9000 {
		t.Errorf("public port = %d, want the preferred 9000", chosen.Public)
	}
}

// A preferred port is a preference, not a requirement: the spec's own rule is that the
// runtime falls forward and the Ready screen says which port it landed on.
func TestAPreferredPortThatIsBusyFallsForward(t *testing.T) {
	chosen, err := choosePorts(thisMac(9000), 9000)
	if err != nil {
		t.Fatal(err)
	}
	if chosen.Public != 9001 {
		t.Errorf("public port = %d, want 9001 — a busy preference falls forward", chosen.Public)
	}
}

// The exclusion list spans both scopes, so a preferred port that happens to be another
// service's default must not be handed out twice.
func TestAPreferredPortDoesNotCollideWithPowerSync(t *testing.T) {
	chosen, err := choosePorts(thisMac(), DefaultPowerSyncPublicPort)
	if err != nil {
		t.Fatal(err)
	}
	if chosen.Public == chosen.PowerSyncPublic {
		t.Errorf("public and powersync public are both %d", chosen.Public)
	}
	if chosen.Public != DefaultPowerSyncPublicPort {
		t.Errorf("public port = %d, want the preferred %d", chosen.Public, DefaultPowerSyncPublicPort)
	}
}
