// Package caddyconf turns the repo's compose Caddyfile into the one this Mac runs.
//
// The bundle ships infra/compose/caddy/Caddyfile verbatim, so the Docker and native
// deployments cannot drift. Four things differ at run time: the two upstream host:port
// pairs (compose service names → loopback ports), and the two document roots (image
// paths → the bundle's web build and the data directory's media folder). Everything
// else — the health endpoint, the forwarded-header pinning, the SPA fallback, the
// {$CADDY_SITE_ADDRESS} placeholders — is left exactly as written.
package caddyconf

import (
	"fmt"
	"strconv"
	"strings"
)

// The tokens as they appear in the compose Caddyfile.
const (
	apiUpstream       = "api:3000"
	powersyncUpstream = "powersync:8080"
	webRootDirective  = "root * /srv"
	mediaRootDirectiv = "root * /data/media"
)

// Config is what the rewrite needs to know.
type Config struct {
	APIPort       int
	PowerSyncPort int
	// WebRoot is the bundle's web/ directory (read-only).
	WebRoot string
	// MediaRoot is the data directory's media/ folder (the api writes, Caddy serves).
	MediaRoot string
}

// Render rewrites source and returns the Caddyfile to run. It refuses rather than
// guesses: a source file missing an expected token would produce a Caddyfile that
// starts green and serves nothing, which no health check would catch.
func Render(source string, cfg Config) (string, error) {
	if cfg.APIPort <= 0 || cfg.PowerSyncPort <= 0 {
		return "", fmt.Errorf("caddyfile: api and powersync ports are required (got %d, %d)", cfg.APIPort, cfg.PowerSyncPort)
	}
	webRoot, err := quotePath(cfg.WebRoot, "web root")
	if err != nil {
		return "", err
	}
	mediaRoot, err := quotePath(cfg.MediaRoot, "media root")
	if err != nil {
		return "", err
	}

	// ReplaceAll, not a single replace: api:3000 appears under /api/* AND under the
	// Google browser callback. Rewriting only the first leaves /auth/google/* pointing
	// at a compose hostname that does not resolve here — Caddy still starts, /healthz
	// still answers 200, and only Google sign-in breaks.
	// Checked in a fixed order so the message is reproducible and always names the most
	// load-bearing missing token first.
	for _, token := range []string{apiUpstream, powersyncUpstream, webRootDirective, mediaRootDirectiv} {
		if !strings.Contains(source, token) {
			return "", fmt.Errorf("caddyfile: expected %q in the bundled Caddyfile but found none — "+
				"the bundle's config/Caddyfile and this rewriter have drifted apart", token)
		}
	}

	out := source
	out = strings.ReplaceAll(out, apiUpstream, "127.0.0.1:"+strconv.Itoa(cfg.APIPort))
	out = strings.ReplaceAll(out, powersyncUpstream, "127.0.0.1:"+strconv.Itoa(cfg.PowerSyncPort))
	out = strings.ReplaceAll(out, webRootDirective, "root * "+webRoot)
	out = strings.ReplaceAll(out, mediaRootDirectiv, "root * "+mediaRoot)
	return out, nil
}

// SiteAddress formats a port as a Caddy listener address. Caddy binds the wildcard for
// a bare ":port", which is exactly what the LAN needs.
func SiteAddress(port int) string {
	return ":" + strconv.Itoa(port)
}

// quotePath wraps a filesystem path for the Caddyfile. The default data directory is
// ~/Library/Application Support/Waffled, so a space is the normal case, not the edge.
func quotePath(path, what string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("caddyfile: %s is required", what)
	}
	if strings.ContainsAny(path, "\"\\\n") {
		return "", fmt.Errorf("caddyfile: %s %q contains a character that cannot be quoted safely", what, path)
	}
	return `"` + path + `"`, nil
}
