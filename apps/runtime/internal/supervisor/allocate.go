package supervisor

import (
	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
)

// choosePorts allocates all five ports in ONE pass with a single running exclusion list.
//
// The exclusion list has to span both scopes, not just each group. None of these ports
// is bound at selection time, so "is it free" cannot tell us that we handed the number
// out thirty microseconds ago — and a wildcard listener and a loopback listener on the
// same port collide anyway. Choosing the public sites and the loopback services in two
// independent passes is what put Caddy's public site and PowerSync's service on the same
// port on this Mac, where Docker holds 8080 and 8081 and the public site therefore falls
// forward onto PowerSync's default of 8082.
//
// isFree is injected so the allocation can be tested against an arbitrary machine.
func choosePorts(isFree func(ports.Scope, int) bool) (rtstate.Ports, error) {
	var chosen rtstate.Ports
	var used []int

	pick := func(scope ports.Scope, preferred int) (int, error) {
		port, err := pickWith(isFree, scope, preferred, portScanWindow, used)
		if err != nil {
			return 0, err
		}
		used = append(used, port)
		return port, nil
	}

	var err error
	// Public first: these are the ports other devices remember, so they get the best
	// claim on the familiar compose numbers.
	if chosen.Public, err = pick(ports.Public, DefaultPublicPort); err != nil {
		return chosen, err
	}
	if chosen.PowerSyncPublic, err = pick(ports.Public, DefaultPowerSyncPublicPort); err != nil {
		return chosen, err
	}
	if chosen.API, err = pick(ports.Loopback, DefaultAPIPort); err != nil {
		return chosen, err
	}
	if chosen.PowerSync, err = pick(ports.Loopback, DefaultPowerSyncPort); err != nil {
		return chosen, err
	}
	if chosen.Postgres, err = pick(ports.Loopback, DefaultPostgresPort); err != nil {
		return chosen, err
	}
	return chosen, nil
}

// pickWith is ports.Pick with the freeness test injected.
func pickWith(isFree func(ports.Scope, int) bool, scope ports.Scope, preferred, window int, exclude []int) (int, error) {
	taken := make(map[int]bool, len(exclude))
	for _, p := range exclude {
		taken[p] = true
	}
	for i := 0; i < window; i++ {
		candidate := preferred + i
		if candidate > 65535 {
			break
		}
		if taken[candidate] {
			continue
		}
		if isFree(scope, candidate) {
			return candidate, nil
		}
	}
	return 0, ports.ErrNoFreePort(scope, preferred, window)
}
