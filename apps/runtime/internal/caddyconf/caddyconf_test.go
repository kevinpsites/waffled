package caddyconf

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The real infra/compose/caddy/Caddyfile, trimmed to the lines that get rewritten.
// Note api:3000 appears TWICE — /api/* and the Google browser callback.
const composeCaddyfile = `{$CADDY_SITE_ADDRESS} {
	encode gzip
	respond /healthz "ok" 200
	handle /api/* {
		reverse_proxy api:3000 {
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle /auth/google/* {
		reverse_proxy api:3000
	}
	handle_path /media/* {
		root * /data/media
		file_server
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}

{$POWERSYNC_CADDY_ADDRESS} {
	encode gzip
	reverse_proxy powersync:8080
}
`

func render(t *testing.T, webRoot, mediaRoot string) string {
	t.Helper()
	out, err := Render(composeCaddyfile, Config{
		APIPort:       3002,
		PowerSyncPort: 8084,
		WebRoot:       webRoot,
		MediaRoot:     mediaRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBothAPIUpstreamsAreRewritten(t *testing.T) {
	out := render(t, "/bundle/web", "/data/media-dir")
	if strings.Contains(out, "api:3000") {
		t.Errorf("a compose upstream survived the rewrite — Google OAuth would 502:\n%s", out)
	}
	if n := strings.Count(out, "reverse_proxy 127.0.0.1:3002"); n != 2 {
		t.Errorf("expected both api upstreams rewritten, found %d:\n%s", n, out)
	}
}

func TestPowerSyncUpstreamIsRewritten(t *testing.T) {
	out := render(t, "/bundle/web", "/data/media-dir")
	if strings.Contains(out, "powersync:8080") {
		t.Errorf("powersync upstream not rewritten:\n%s", out)
	}
	if !strings.Contains(out, "reverse_proxy 127.0.0.1:8084") {
		t.Errorf("expected the powersync loopback upstream:\n%s", out)
	}
}

// The default data dir is ~/Library/Application Support/Waffled — a path with a space.
// Unquoted, Caddy reads "Support/Waffled/media" as a second argument and fails to adapt.
func TestRootPathsWithSpacesAreQuoted(t *testing.T) {
	web := "/Applications/Waffled.app/Contents/Resources/runtime/web"
	media := "/Users/kev/Library/Application Support/Waffled/media"
	out := render(t, web, media)
	if !strings.Contains(out, `root * "`+media+`"`) {
		t.Errorf("media root must be quoted:\n%s", out)
	}
	if !strings.Contains(out, `root * "`+web+`"`) {
		t.Errorf("web root must be quoted:\n%s", out)
	}
	if strings.Contains(out, "root * /srv") || strings.Contains(out, "root * /data/media") {
		t.Errorf("a compose root path survived:\n%s", out)
	}
}

// A path containing a double quote would break out of the quoting we add. Refuse it
// rather than emit a Caddyfile that means something else.
func TestRefusesAPathThatCannotBeQuotedSafely(t *testing.T) {
	_, err := Render(composeCaddyfile, Config{
		APIPort: 3002, PowerSyncPort: 8084,
		WebRoot:   `/tmp/we"ird`,
		MediaRoot: "/tmp/media",
	})
	if err == nil {
		t.Fatal("a root path containing a double quote must be refused")
	}
}

func TestSiteAddressesAreEnvironmentDriven(t *testing.T) {
	// The site addresses stay as {$CADDY_SITE_ADDRESS}/{$POWERSYNC_CADDY_ADDRESS}
	// placeholders — the runtime supplies them through the child environment, exactly
	// as compose does, so the file stays comparable to the repo's.
	out := render(t, "/w", "/m")
	if !strings.Contains(out, "{$CADDY_SITE_ADDRESS}") || !strings.Contains(out, "{$POWERSYNC_CADDY_ADDRESS}") {
		t.Errorf("site address placeholders should be preserved:\n%s", out)
	}
}

func TestRenderIsAnErrorWhenAnUpstreamIsMissing(t *testing.T) {
	// If upstream Caddyfile edits ever rename the compose hosts, silently producing a
	// file with no api upstream would start Caddy green and break every API call.
	_, err := Render("{$CADDY_SITE_ADDRESS} {\n\trespond /healthz \"ok\" 200\n}\n", Config{
		APIPort: 3002, PowerSyncPort: 8084, WebRoot: "/w", MediaRoot: "/m",
	})
	if err == nil {
		t.Fatal("a Caddyfile with no api:3000 upstream must be refused")
	}
	if !strings.Contains(err.Error(), "api:3000") {
		t.Errorf("the error should say what it looked for, got %q", err)
	}
}

func TestSiteAddressHelpers(t *testing.T) {
	if got := SiteAddress(8082); got != ":8082" {
		t.Errorf("SiteAddress(8082) = %q, want \":8082\"", got)
	}
}

// The bundle ships infra/compose/caddy/Caddyfile verbatim, so the rewrite must keep
// working against the real file. This is the drift alarm: if someone renames an
// upstream in compose, this fails here rather than at a customer's first sign-in.
func TestRewritesTheRepoCaddyfile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "infra", "compose", "caddy", "Caddyfile"))
	if err != nil {
		t.Skipf("repo Caddyfile not readable from here: %v", err)
	}
	out, err := Render(string(raw), Config{
		APIPort: 3002, PowerSyncPort: 8084,
		WebRoot:   "/Applications/Waffled.app/Contents/Resources/runtime/web",
		MediaRoot: "/Users/kev/Library/Application Support/Waffled/media",
	})
	if err != nil {
		t.Fatalf("the real compose Caddyfile no longer rewrites: %v", err)
	}
	for _, gone := range []string{"api:3000", "powersync:8080", "root * /srv", "root * /data/media"} {
		if strings.Contains(out, gone) {
			t.Errorf("%q survived the rewrite of the real Caddyfile", gone)
		}
	}
	if n := strings.Count(out, "127.0.0.1:3002"); n != 2 {
		t.Errorf("the real Caddyfile has %d api upstreams rewritten, expected 2", n)
	}
}
