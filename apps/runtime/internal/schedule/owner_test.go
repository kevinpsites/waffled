package schedule

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A launchd agent whose program is a bare executable is listed in Login Items &
// Extensions as that executable: "waffled-runtime", a generic exec icon, and "Item from
// unidentified developer". `AssociatedBundleIdentifiers` is what tells macOS the agent
// belongs to an app, so the row becomes the app's name and the app's icon.
//
// The identifier is read from the app the binary is actually inside rather than written
// down here, because a runtime run from Terminal is inside no app and must claim none.

func appBundle(t *testing.T, identifier string) string {
	t.Helper()
	app := filepath.Join(t.TempDir(), "Waffled.app")
	binDir := filepath.Join(app, "Contents", "Resources", "runtime", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	plist := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<plist version=\"1.0\"><dict>\n" +
		"<key>CFBundleIdentifier</key><string>" + identifier + "</string>\n" +
		"</dict></plist>\n"
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(binDir, "waffled-runtime")
}

func TestAnAgentInsideAnAppIsListedUnderThatApp(t *testing.T) {
	binary := appBundle(t, "app.waffled.mac")
	a, err := For(binary, filepath.Dir(filepath.Dir(binary)), "/tmp/d", "/tmp/d/logs/backup.log")
	if err != nil {
		t.Fatal(err)
	}
	a.At = "03:00"

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte("AssociatedBundleIdentifiers")) {
		t.Fatalf("the agent should name the app it belongs to:\n%s", body)
	}
	if !bytes.Contains(body, []byte("app.waffled.mac")) {
		t.Errorf("the app's own identifier should be the one named:\n%s", body)
	}
}

// Run from Terminal, or from a build tree, there is no app — and claiming one that is not
// there would point Login Items at nothing.
func TestAnAgentOutsideAnAppClaimsNoApp(t *testing.T) {
	a, err := For("/usr/local/bin/waffled-runtime", "/usr/local/share/waffled",
		"/tmp/d", "/tmp/d/logs/backup.log")
	if err != nil {
		t.Fatal(err)
	}
	a.At = "03:00"

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte("AssociatedBundleIdentifiers")) {
		t.Errorf("a runtime outside an app has no app to be listed under:\n%s", body)
	}
}

// An app bundle whose Info.plist cannot be read is the same case as no app at all: the
// schedule still installs, it is just listed under its own name.
func TestAnUnreadableAppIsNotGuessedAt(t *testing.T) {
	binary := appBundle(t, "app.waffled.mac")
	if err := os.Remove(filepath.Join(
		strings.Split(binary, "/Contents/")[0], "Contents", "Info.plist")); err != nil {
		t.Fatal(err)
	}
	a, err := For(binary, filepath.Dir(filepath.Dir(binary)), "/tmp/d", "/tmp/d/logs/backup.log")
	if err != nil {
		t.Fatal(err)
	}
	a.At = "03:00"

	body, err := a.Plist()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte("AssociatedBundleIdentifiers")) {
		t.Errorf("nothing said the identifier, so nothing should claim one:\n%s", body)
	}
}
