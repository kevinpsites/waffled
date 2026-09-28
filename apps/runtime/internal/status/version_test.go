package status

import (
	"strings"
	"testing"
)

// The crossing line used to say "updated from" for every version change there was. The
// documented recovery from the downgrade guard is to re-install the OLDER build and
// restore a snapshot, so the first thing a person saw after following that advice was
// "Updated to 0.14.3, from 0.15.0" — an update message describing the rollback they had
// just performed on purpose, at the moment they most needed the tool to agree with them.
func TestTheCrossingLineNamesItsDirection(t *testing.T) {
	cases := []struct {
		what     string
		previous string
		current  string
		want     string
	}{
		{"an update", "0.14.3", "0.15.0", "updated from 0.14.3"},
		{"a rollback", "0.15.0", "0.14.3", "rolled back from 0.15.0"},
		// 0.9.0 → 0.10.0 is the case a string comparison gets backwards, and this repo
		// will cross it.
		{"an update over a ten", "0.9.0", "0.10.0", "updated from 0.9.0"},
		{"a rollback over a ten", "0.10.0", "0.9.0", "rolled back from 0.10.0"},
		// Nothing to order: a dev build, a rename, anything that is not MAJOR.MINOR.PATCH.
		// It still happened, and saying so without claiming a direction is the honest
		// reading — inventing one would be the bug this test exists for.
		{"an unorderable pair", "main-abc1234", "0.15.0", "changed from main-abc1234"},
		{"two unorderable", "dev", "dev-2", "changed from dev"},
		// Build metadata is not part of the ordering, so these two are the same version
		// by number while still being a different build. Neither "updated" nor "rolled
		// back" is true of it.
		{"the same version, a different build", "0.15.0+a1b2c3", "0.15.0", "changed from 0.15.0+a1b2c3"},
	}
	for _, tc := range cases {
		t.Run(tc.what, func(t *testing.T) {
			r := sample()
			r.Bundle.Version = tc.current
			r.Bundle.PreviousVersion = tc.previous
			r.Bundle.VersionChangedAt = "2026-09-08T03:00:00Z"

			out := r.Text()
			if !strings.Contains(out, tc.want) {
				t.Errorf("status does not say %q:\n%s", tc.want, out)
			}
			if !strings.Contains(out, "2026-09-08T03:00:00Z") {
				t.Errorf("the crossing line lost when it happened:\n%s", out)
			}
			// Only one direction may be claimed, whichever it is.
			for _, other := range []string{"updated from", "rolled back from", "changed from"} {
				if strings.HasPrefix(tc.want, other) {
					continue
				}
				if strings.Contains(out, other) {
					t.Errorf("status also claims %q:\n%s", other, out)
				}
			}
		})
	}
}

// Data that has only ever known one version has no crossing to report, and a line saying
// so would greet every new install with news about an update that never happened.
//
// The timestamp is set and the previous version is not, on purpose: PreviousVersion is
// what the line is keyed on, and keying it on the timestamp instead would pass a test that
// left both empty while printing "changed from  on 2026-09-08…" for a first start.
func TestNoCrossingLineWithoutAPreviousVersion(t *testing.T) {
	r := sample()
	r.Bundle.Version = "0.15.0"
	r.Bundle.VersionChangedAt = "2026-09-08T03:00:00Z"
	out := r.Text()
	for _, phrase := range []string{"updated from", "rolled back from", "changed from"} {
		if strings.Contains(out, phrase) {
			t.Errorf("status reports a crossing on data that has only known one version (%q):\n%s", phrase, out)
		}
	}
}

func TestVersionsAreOrderedNumericallyNotLexically(t *testing.T) {
	ordered := []struct {
		lower, higher string
	}{
		{"0.9.0", "0.10.0"},   // the one a string compare gets wrong
		{"0.14.3", "0.15.0"},  // ordinary
		{"0.15", "0.15.1"},    // a short version is not an unreadable one
		{"1.2.3", "2.0.0"},    // major
		{"0.15.0", "0.15.10"}, // patch, past nine
	}
	for _, tc := range ordered {
		if order, ok := compareVersions(tc.lower, tc.higher); !ok || order >= 0 {
			t.Errorf("compareVersions(%q, %q) = %d, %v — want a negative order", tc.lower, tc.higher, order, ok)
		}
		if order, ok := compareVersions(tc.higher, tc.lower); !ok || order <= 0 {
			t.Errorf("compareVersions(%q, %q) = %d, %v — want a positive order", tc.higher, tc.lower, order, ok)
		}
	}

	// Equal by number, including where one writes segments the other leaves off and where
	// build metadata differs. Build metadata says WHICH build, never which is newer.
	for _, tc := range [][2]string{
		{"0.15.0", "0.15.0"},
		{"0.15", "0.15.0"},
		{"0.15.0+a1b2c3", "0.15.0"},
		{"0.15.0+a1b2c3", "0.15.0+d4e5f6"},
	} {
		if order, ok := compareVersions(tc[0], tc[1]); !ok || order != 0 {
			t.Errorf("compareVersions(%q, %q) = %d, %v — want equal", tc[0], tc[1], order, ok)
		}
	}

	// Not orderable, and saying so is the point: a guess here becomes a wrong direction
	// printed in `status`.
	for _, tc := range [][2]string{
		{"", "0.15.0"},
		{"0.15.0", ""},
		{"main-abc1234", "0.15.0"},
		{"0.15.0-rc1", "0.15.0"},
		{"0.15.0.1", "0.15.0"},
		{"dev", "dev"},
	} {
		if order, ok := compareVersions(tc[0], tc[1]); ok {
			t.Errorf("compareVersions(%q, %q) = %d, true — want it to decline to order them", tc[0], tc[1], order)
		}
	}
}
