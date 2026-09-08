package supervisor

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWaitHTTPReturnsOnceTheServiceAnswers(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := waitHTTP(context.Background(), srv.URL, 5*time.Second, nil); err != nil {
		t.Fatalf("waitHTTP should have succeeded once the service came up: %v", err)
	}
	if hits.Load() < 3 {
		t.Errorf("expected retries, got %d requests", hits.Load())
	}
}

func TestWaitHTTPTimesOutWithAUsefulMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := waitHTTP(context.Background(), srv.URL, 700*time.Millisecond, nil)
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if !strings.Contains(err.Error(), srv.URL) {
		t.Errorf("the error should name the URL it waited on, got %q", err)
	}
}

// Waiting the full timeout on a process that has already died wastes 30-60 seconds and
// buries the real error. The liveness callback short-circuits it.
func TestWaitHTTPFailsFastWhenTheProcessDied(t *testing.T) {
	died := errors.New("api exited with status 1")
	start := time.Now()
	err := waitHTTP(context.Background(), "http://127.0.0.1:1/never", 30*time.Second, func() error { return died })
	if err == nil {
		t.Fatal("expected an error")
	}
	if !errors.Is(err, died) {
		t.Errorf("the process error should be wrapped, got %q", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("should have failed fast, took %s", elapsed)
	}
}

func TestWaitHTTPHonoursContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	if err := waitHTTP(ctx, "http://127.0.0.1:1/never", 30*time.Second, nil); err == nil {
		t.Fatal("expected an error on cancellation")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("cancellation was not honoured, took %s", elapsed)
	}
}

// Caddy answers /healthz with the SPA body in some configurations; only the status
// matters. A 401 from an admin-only route, by contrast, is not health.
func TestHTTPOKAcceptsAny2xxOnly(t *testing.T) {
	cases := map[int]bool{200: true, 204: true, 301: false, 401: false, 500: false}
	for code, want := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		if got := httpOK(context.Background(), srv.URL); got != want {
			t.Errorf("status %d: httpOK = %v, want %v", code, got, want)
		}
		srv.Close()
	}
}

func TestBackoffGrowsThenCaps(t *testing.T) {
	var prev time.Duration
	for attempt := 1; attempt <= 12; attempt++ {
		d := restartBackoff(attempt)
		if d < prev {
			t.Errorf("backoff went backwards at attempt %d: %s after %s", attempt, d, prev)
		}
		if d > maxRestartBackoff {
			t.Errorf("attempt %d: backoff %s exceeds the cap %s", attempt, d, maxRestartBackoff)
		}
		prev = d
	}
	if restartBackoff(1) > 2*time.Second {
		t.Errorf("the first retry should be prompt, got %s", restartBackoff(1))
	}
}
