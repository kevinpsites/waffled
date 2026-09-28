package supervisor

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

const (
	healthPollInterval = 250 * time.Millisecond
	healthRequestTimo  = 2 * time.Second
	baseRestartBackoff = time.Second
	maxRestartBackoff  = 30 * time.Second
)

// healthClient never follows redirects: a 301 to https is not a healthy service here,
// and following it would turn a misconfiguration into a false green.
var healthClient = &http.Client{
	Timeout: healthRequestTimo,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// httpOK reports whether the endpoint answers 2xx. Only the status is inspected —
// Caddy's /healthz serves the SPA body in this configuration, a pre-existing quirk of
// the shared Caddyfile.
func httpOK(ctx context.Context, url string) bool {
	ctx, cancel := context.WithTimeout(ctx, healthRequestTimo)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := healthClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// waitHTTP polls url until it answers 2xx, the deadline passes, or alive reports that
// the process behind it has died. That last check is what turns "waited 60 seconds and
// then said the api is not answering" into "the api exited with status 1" immediately.
func waitHTTP(ctx context.Context, url string, timeout time.Duration, alive func() error) error {
	deadline := time.Now().Add(timeout)
	for {
		if alive != nil {
			if err := alive(); err != nil {
				return fmt.Errorf("gave up waiting for %s: %w", url, err)
			}
		}
		if httpOK(ctx, url) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for %s: %w", url, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s did not answer within %s", url, timeout)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for %s: %w", url, ctx.Err())
		case <-time.After(healthPollInterval):
		}
	}
}

// restartBackoff spaces out restarts of a service that keeps dying: prompt for a one-off
// crash, but capped so a genuinely broken service does not spin the CPU or fill the log.
func restartBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := baseRestartBackoff
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= maxRestartBackoff {
			return maxRestartBackoff
		}
	}
	return d
}
