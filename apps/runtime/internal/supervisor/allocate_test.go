package supervisor

import (
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
)

// thisMac mimics the dev Mac, where Docker holds the compose ports: *:8080, *:8081,
// *:8090 and 127.0.0.1:3000, 127.0.0.1:5432. Every default therefore has to fall
// forward, which is exactly the situation that exposed the bug below.
func thisMac(taken ...int) func(ports.Scope, int) bool {
	busy := map[int]bool{}
	for _, p := range taken {
		busy[p] = true
	}
	return func(_ ports.Scope, port int) bool { return !busy[port] }
}

// The bug this guards against: the public ports and the loopback ports were chosen in
// two separate passes, each excluding only its own group. With 8080/8081 taken the
// public site landed on 8082 — and PowerSync's loopback default IS 8082, which was
// still unbound at selection time, so it was handed out twice. Postgres, migrate, the
// api and PowerSync all came up green and only Caddy failed, 30 seconds later, on a
// port already held by a service we had started ourselves.
func TestChoosePortsNeverHandsOutThePortTwice(t *testing.T) {
	chosen, err := choosePorts(thisMac(8080, 8081, 8090, 3000, 5432), DefaultPublicPort)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int]string{}
	for name, port := range map[string]int{
		"public": chosen.Public, "powersyncPublic": chosen.PowerSyncPublic,
		"api": chosen.API, "powersync": chosen.PowerSync, "postgres": chosen.Postgres,
	} {
		if other, dup := seen[port]; dup {
			t.Errorf("%s and %s were both given port %d", other, name, port)
		}
		seen[port] = name
		if port == 0 {
			t.Errorf("%s has no port", name)
		}
	}
	t.Logf("chose %+v", chosen)
}

func TestChoosePortsPrefersTheDefaultsWhenFree(t *testing.T) {
	chosen, err := choosePorts(thisMac(), DefaultPublicPort)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][2]int{
		"public":          {chosen.Public, DefaultPublicPort},
		"powersyncPublic": {chosen.PowerSyncPublic, DefaultPowerSyncPublicPort},
		"api":             {chosen.API, DefaultAPIPort},
		"powersync":       {chosen.PowerSync, DefaultPowerSyncPort},
		"postgres":        {chosen.Postgres, DefaultPostgresPort},
	}
	for name, pair := range want {
		if pair[0] != pair[1] {
			t.Errorf("%s = %d on an empty machine, want the default %d", name, pair[0], pair[1])
		}
	}
}

// A taken default must move to the next free port, not fail.
func TestChoosePortsFallsForward(t *testing.T) {
	chosen, err := choosePorts(thisMac(DefaultPublicPort), DefaultPublicPort)
	if err != nil {
		t.Fatal(err)
	}
	if chosen.Public == DefaultPublicPort {
		t.Fatalf("public port %d was supposed to be taken", chosen.Public)
	}
	if chosen.Public <= DefaultPublicPort {
		t.Errorf("public = %d, expected a port above the taken default", chosen.Public)
	}
}

// The default PowerSync loopback port (8082) sits right where the public site lands when
// 8080 and 8081 are busy. Pin the specific arrangement so it cannot regress.
func TestPublicAndPowerSyncDoNotCollideWhenTheComposePortsAreBusy(t *testing.T) {
	chosen, err := choosePorts(thisMac(8080, 8081), DefaultPublicPort)
	if err != nil {
		t.Fatal(err)
	}
	if chosen.Public == chosen.PowerSync {
		t.Fatalf("the public site and the powersync service both got port %d", chosen.Public)
	}
	if chosen.Public == chosen.PowerSyncPublic {
		t.Fatalf("both Caddy sites got port %d", chosen.Public)
	}
}
