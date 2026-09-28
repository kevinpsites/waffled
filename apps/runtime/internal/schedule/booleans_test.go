package schedule

import (
	"bytes"
	"testing"
)

// launchd's own parser refuses `<false></false>` — `launchctl bootstrap` answers
// "Bootstrap failed: 5: Input/output error" and loads nothing — while accepting
// `<false/>`. Go's encoding/xml writes the first for an empty element and offers no way
// to ask for the second, so the bytes are fixed up after marshalling.
//
// This is asserted on the RAW BYTES on purpose. `plutil -lint` accepts both spellings,
// and so does every plist reader in this repo, so nothing else here can catch the
// difference — including the `plutil -lint` guard CI runs over the entitlements plists.
// Measured on macOS 15.7: identical dictionaries, one bootstraps and one does not.
func TestBooleansAreSelfClosingBecauseLaunchdRefusesTheOtherSpelling(t *testing.T) {
	a, err := For("/Applications/Waffled.app/Contents/Resources/runtime/bin/waffled-runtime",
		"/Applications/Waffled.app/Contents/Resources/runtime",
		"/tmp/waffled-data", "/tmp/waffled-data/logs/backup.log")
	if err != nil {
		t.Fatal(err)
	}
	a.At = "03:00"

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}

	if bytes.Contains(body, []byte("<false></false>")) {
		t.Error("<false></false> is what launchd refuses with EIO; it has to be <false/>")
	}
	if bytes.Contains(body, []byte("<true></true>")) {
		t.Error("<true></true> would fail the same way")
	}
	// The plist really does carry both booleans, so the assertions above are not vacuous.
	if !bytes.Contains(body, []byte("<false/>")) {
		t.Errorf("expected a self-closing <false/> in:\n%s", body)
	}
	if n := bytes.Count(body, []byte("<false/>")); n != 2 {
		t.Errorf("RunAtLoad and AbandonProcessGroup are both false, got %d", n)
	}
}
