package status

import (
	"strconv"
	"strings"
)

// Version ordering, for the one question `status` asks about it: which way did this data
// directory cross between two builds?
//
// It is deliberately not a semver library. The only versions being compared here are two
// values this project put in its own bundle manifests, and the only decision resting on
// the answer is which of three English phrases to print. What a real semver parser would
// add is precedence rules for pre-release identifiers — and this refuses to order those
// at all, because getting the direction WRONG is the failure that matters and "changed
// from" is always available and always true.

// versionSegments is the MAJOR.MINOR.PATCH prefix, the only part that carries order.
const versionSegments = 3

// compareVersions orders two versions the way a person reads them: -1 when a is older
// than b, +1 when it is newer, 0 when they are the same version. ok is false when either
// side is not a plain MAJOR.MINOR.PATCH number, which is a real answer rather than a
// failure — an unorderable pair still crossed, it just did not cross in a direction that
// can be named.
func compareVersions(a, b string) (int, bool) {
	x, ok := parseVersion(a)
	if !ok {
		return 0, false
	}
	y, ok := parseVersion(b)
	if !ok {
		return 0, false
	}
	for i := range x {
		switch {
		case x[i] < y[i]:
			return -1, true
		case x[i] > y[i]:
			return 1, true
		}
	}
	return 0, true
}

// parseVersion reads the numeric prefix, or declines.
//
// Two rules earn their place. Segments left off count as zero, so 0.15 and 0.15.0 are the
// same version rather than an unorderable pair. And anything after a `+` is dropped: build
// metadata says WHICH build, never which is newer, so 0.15.0+a1b2c3 and 0.15.0 compare
// equal — different builds of one version, which is a change with no direction.
func parseVersion(v string) ([versionSegments]int, bool) {
	var out [versionSegments]int
	v, _, _ = strings.Cut(strings.TrimSpace(v), "+")
	parts := strings.Split(v, ".")
	if len(parts) > versionSegments {
		return out, false
	}
	for i, p := range parts {
		// Atoi is doing the refusing here: an empty string, a pre-release suffix
		// ("0.15.0-rc1"), a git description ("main-abc1234") and a leading "v" all land
		// on the same honest "cannot order these".
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// crossingPhrase is how the version change is announced: the direction when there is one,
// and plain "changed" when the two versions cannot be ordered.
//
// The direction is derived rather than recorded, because the FILE it comes from
// (runtime.json) stores only the two versions and the moment — the crossing has no
// direction of its own, only two endpoints, and a recorded direction would be one more
// thing that could disagree with them.
func (b Bundle) crossingPhrase() string {
	order, ok := compareVersions(b.PreviousVersion, b.Version)
	switch {
	case !ok || order == 0:
		return "changed from"
	case order < 0:
		return "updated from"
	default:
		return "rolled back from"
	}
}
