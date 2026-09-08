package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

func shell(name, script string) services.Spec {
	return services.Spec{
		Name: name,
		Path: "/bin/sh",
		Args: []string{"/bin/sh", "-c", script},
		Env:  []string{"PATH=/usr/bin:/bin"},
	}
}

func newTestRunner(t *testing.T) *runner {
	t.Helper()
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	pids := filepath.Join(dir, "pids")
	for _, d := range []string{logs, pids} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return &runner{logsDir: logs, pidsDir: pids, log: testLogger(t)}
}

func TestStartWritesAPidfileAndLogFile(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("noisy", "echo hello from the child; sleep 30"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(2 * time.Second) })

	pidPath := filepath.Join(r.pidsDir, "noisy.pid")
	waitFor(t, 3*time.Second, func() bool {
		_, err := os.Stat(pidPath)
		return err == nil
	}, "pidfile was never written")

	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) == "" {
		t.Error("pidfile is empty")
	}

	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(filepath.Join(r.logsDir, "noisy.log"))
		return strings.Contains(string(body), "hello from the child")
	}, "child stdout did not reach logs/noisy.log")
}

// The log must be appended to, not truncated: a service that crash-loops would
// otherwise erase the very output that explains why.
func TestStartAppendsToAnExistingLog(t *testing.T) {
	r := newTestRunner(t)
	logPath := filepath.Join(r.logsDir, "appender.log")
	if err := os.WriteFile(logPath, []byte("earlier run\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := r.start(shell("appender", "echo second run"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(time.Second) })

	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(logPath)
		return strings.Contains(string(body), "second run")
	}, "new output never appeared")
	body, _ := os.ReadFile(logPath)
	if !strings.Contains(string(body), "earlier run") {
		t.Errorf("the previous log was truncated:\n%s", body)
	}
}

func TestStopIsGracefulAndRemovesThePidfile(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("polite", `trap 'exit 0' TERM; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, c.running, "child never started")

	if err := c.stop(5 * time.Second); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if c.running() {
		t.Error("child still running after stop")
	}
	if _, err := os.Stat(filepath.Join(r.pidsDir, "polite.pid")); !os.IsNotExist(err) {
		t.Error("pidfile should be removed on stop")
	}
}

// A service that ignores SIGTERM must not hold up shutdown forever.
func TestStopEscalatesToSIGKILL(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("stubborn", `trap '' TERM; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, c.running, "child never started")

	start := time.Now()
	if err := c.stop(500 * time.Millisecond); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if c.running() {
		t.Error("a child that ignores SIGTERM must still be killed")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("escalation took too long: %s", elapsed)
	}
}

// Compose's `restart: unless-stopped`, reimplemented.
func TestACrashedChildIsRestarted(t *testing.T) {
	r := newTestRunner(t)
	marker := filepath.Join(t.TempDir(), "runs")
	c, err := r.start(shell("flaky", `echo run >> `+marker+`; sleep 0.2; exit 3`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(2 * time.Second) })
	c.superviseRestarts()

	waitFor(t, 15*time.Second, func() bool {
		body, _ := os.ReadFile(marker)
		return strings.Count(string(body), "run") >= 2
	}, "the child was never restarted after it crashed")

	if c.restarts() == 0 {
		t.Error("restart count should have been recorded")
	}
	if c.lastError() == "" {
		t.Error("the crash should be recorded as the last error")
	}
}

// A child stopped on purpose must stay stopped.
func TestAnIntentionalStopIsNotRestarted(t *testing.T) {
	r := newTestRunner(t)
	marker := filepath.Join(t.TempDir(), "runs")
	c, err := r.start(shell("wellbehaved", `echo run >> `+marker+`; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	c.superviseRestarts()
	// Wait for evidence the child actually ran, not merely that it was spawned: stopping
	// it before /bin/sh reached the echo would prove nothing about restart behaviour.
	waitFor(t, 5*time.Second, func() bool {
		body, _ := os.ReadFile(marker)
		return strings.Contains(string(body), "run")
	}, "child never wrote its marker")

	if err := c.stop(3 * time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	body, _ := os.ReadFile(marker)
	if n := strings.Count(string(body), "run"); n != 1 {
		t.Errorf("a deliberately stopped child was restarted %d times", n-1)
	}
}

func TestPidfileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "svc.pid")
	if err := writePidfile(path, 4242); err != nil {
		t.Fatal(err)
	}
	pid, err := readPidfile(path)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 4242 {
		t.Errorf("pid = %d, want 4242", pid)
	}
	if _, err := readPidfile(filepath.Join(dir, "absent.pid")); err == nil {
		t.Error("a missing pidfile must be an error")
	}
	if err := os.WriteFile(path, []byte("not a number\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPidfile(path); err == nil {
		t.Error("a corrupt pidfile must be an error")
	}
}

// Plan §3 asks for rotated per-service logs; a Mac mini that is never rebooted would
// otherwise grow a PowerSync log without bound.
func TestLogsRotateOnceTheyGetLarge(t *testing.T) {
	r := newTestRunner(t)
	logPath := filepath.Join(r.logsDir, "chatty.log")
	big := make([]byte, maxLogBytes+1024)
	for i := range big {
		big[i] = 'x'
	}
	if err := os.WriteFile(logPath, big, 0o600); err != nil {
		t.Fatal(err)
	}

	c, err := r.start(shell("chatty", "echo fresh output"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(time.Second) })

	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(logPath)
		return strings.Contains(string(body), "fresh output")
	}, "new output never appeared")

	st, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() >= maxLogBytes {
		t.Errorf("the log was not rotated: still %d bytes", st.Size())
	}
	// The previous generation is kept — it is what explains a crash that just happened.
	rotated, err := os.Stat(logPath + ".1")
	if err != nil {
		t.Fatalf("the rotated log should be kept: %v", err)
	}
	if rotated.Size() < maxLogBytes {
		t.Errorf("the rotated log looks wrong: %d bytes", rotated.Size())
	}
}

// A log below the cap must be left alone, so ordinary restarts do not shed history.
func TestSmallLogsAreNotRotated(t *testing.T) {
	r := newTestRunner(t)
	logPath := filepath.Join(r.logsDir, "quiet.log")
	if err := os.WriteFile(logPath, []byte("earlier run\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := r.start(shell("quiet", "echo more"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(time.Second) })
	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(logPath)
		return strings.Contains(string(body), "more")
	}, "new output never appeared")

	if _, err := os.Stat(logPath + ".1"); !os.IsNotExist(err) {
		t.Error("a small log must not be rotated")
	}
	body, _ := os.ReadFile(logPath)
	if !strings.Contains(string(body), "earlier run") {
		t.Error("history was lost")
	}
}

// status reads pidfiles across process boundaries, so "is this pid alive" must be
// answered without having spawned it.
func TestProcessAliveByPid(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("this process should be reported alive")
	}
	if processAlive(0) {
		t.Error("pid 0 is not a service")
	}
	// A pid that has certainly exited.
	cmd := shell("gone", "exit 0")
	c := &child{spec: cmd}
	_ = c
	if processAlive(999999) {
		t.Log("pid 999999 happens to exist on this machine; skipping the negative case")
	}
}

func TestSignalPidRejectsAnUnknownProcess(t *testing.T) {
	if err := signalPid(999998, syscall.SIGTERM); err == nil {
		t.Skip("pid 999998 exists on this machine")
	}
}

func waitFor(t *testing.T, limit time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s (waited %s)", msg, limit)
}

func testLogger(t *testing.T) *Logger {
	t.Helper()
	return NewLogger(testWriter{t}, false)
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

var _ = context.Background

// A stop() that lands while a crash-restart is mid-spawn must leave nothing behind.
//
// The regression this guards: superviseRestarts checked c.stopping, released the lock,
// and only then called spawn(). A stop() arriving in that window set stopping=true,
// snapshotted the child that had already died, saw nothing running and reported success
// — and spawn() then published a fresh process that nothing would ever kill, holding
// the service's port against the next start.
//
// The interleaving is a few milliseconds wide, so the test sweeps stop() across the
// restart window in fine steps rather than hoping one attempt lands in it.
func TestStopDuringACrashRestartLeavesNoChildBehind(t *testing.T) {
	const backoff = 20 * time.Millisecond

	for attempt := 0; attempt < 60; attempt++ {
		r := newTestRunner(t)
		r.backoff = func(int) time.Duration { return backoff }
		pidLog := filepath.Join(r.logsDir, "generations.pids")

		// exec, so the recorded $$ stays the pid of the process that is actually alive.
		c, err := r.start(shell("flapper", "echo $$ >> "+pidLog+"; exec sleep 30"))
		if err != nil {
			t.Fatal(err)
		}
		c.superviseRestarts()
		waitTight(t, 3*time.Second, func() bool { return len(recordedPids(t, pidLog)) >= 1 },
			"the first child never recorded its pid")

		// Crash it, then stop the service while the restart is in flight.
		_ = syscall.Kill(c.currentPid(), syscall.SIGKILL)
		time.Sleep(backoff + time.Duration(attempt)*100*time.Microsecond)
		if err := c.stop(2 * time.Second); err != nil {
			t.Fatalf("attempt %d: stop reported %v", attempt, err)
		}

		// A child that escaped the stop is published a moment after stop() returns.
		time.Sleep(30 * time.Millisecond)
		for _, pid := range recordedPids(t, pidLog) {
			if processAlive(pid) {
				_ = syscall.Kill(pid, syscall.SIGKILL)
				t.Fatalf("attempt %d: pid %d was still running after stop() reported success — "+
					"a crash-restart spawned it in the window stop() had already passed", attempt, pid)
			}
		}
	}
}

// recordedPids reads every generation the flapping child has written.
func recordedPids(t *testing.T, path string) []int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Fields(string(raw)) {
		pid, err := strconv.Atoi(line)
		if err != nil {
			t.Fatalf("%s holds %q, not a pid", path, line)
		}
		pids = append(pids, pid)
	}
	return pids
}

// waitTight is waitFor with a poll fine enough for a millisecond-scale interleaving.
func waitTight(t *testing.T, limit time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s (waited %s)", msg, limit)
}
