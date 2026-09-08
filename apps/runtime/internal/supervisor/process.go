package supervisor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// runner spawns and tracks the long-running children — api, PowerSync and Caddy.
//
// Postgres is deliberately NOT one of these. pg_ctl exits as soon as the postmaster is
// accepting connections, so watching it as a child would read a successful start as an
// immediate crash and restart-loop forever. Postgres is started and stopped through
// pg_ctl and observed through pg_isready and postmaster.pid instead (see postgres.go).
type runner struct {
	logsDir string
	pidsDir string
	log     *Logger
	// backoff spaces out restarts. Nil means restartBackoff; a test overrides it to keep
	// an interleaving test fast rather than sleeping out real seconds.
	backoff func(attempt int) time.Duration
}

func (r *runner) restartDelay(attempt int) time.Duration {
	if r.backoff != nil {
		return r.backoff(attempt)
	}
	return restartBackoff(attempt)
}

// child is one supervised process.
type child struct {
	runner *runner
	spec   services.Spec

	// lifecycle serializes "decide to spawn" against "decide to stop". mu alone cannot:
	// spawn does file and fork work that must not run under a lock a status call also
	// takes, so superviseRestarts used to release mu before spawning — and a stop() in
	// that window saw the dead child, reported success, and left the new one running
	// unsupervised on its port. Taking lifecycle around the whole of [check stopping →
	// publish the new cmd], and again in stop() before it snapshots cmd, means stop()
	// either wins the race (the restart then sees stopping and never spawns) or waits
	// and snapshots the child that was just published. Always taken before mu, and
	// never held while waiting for a process to exit.
	lifecycle sync.Mutex

	mu        sync.Mutex
	cmd       *exec.Cmd
	pid       int
	stopping  bool
	exited    bool
	restartN  int
	lastErr   string
	waitDone  chan struct{}
	exitError error
}

func (r *runner) logPath(name string) string { return filepath.Join(r.logsDir, name+".log") }
func (r *runner) pidPath(name string) string { return filepath.Join(r.pidsDir, name+".pid") }

// start launches the spec, appending its stdout and stderr to logs/<name>.log and
// recording the pid so `status` and `stop` can find it from another process.
func (r *runner) start(spec services.Spec) (*child, error) {
	c := &child{runner: r, spec: spec}
	c.lifecycle.Lock()
	defer c.lifecycle.Unlock()
	if err := c.spawn(); err != nil {
		return nil, err
	}
	return c, nil
}

// spawn must be called with c.lifecycle held, so that no stop() can slip between the
// caller's "not stopping" decision and the moment the new cmd is published.
func (c *child) spawn() error {
	logPath := c.runner.logPath(c.spec.Name)
	if err := rotateIfLarge(logPath); err != nil {
		c.runner.log.Warnf("could not rotate %s: %v", logPath, err)
	}
	// Append, never truncate: a crash-looping service would otherwise erase the output
	// that explains the crash.
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open the %s log: %w", c.spec.Name, err)
	}

	cmd := exec.Command(c.spec.Path)
	cmd.Args = c.spec.Args
	cmd.Env = c.spec.Env // never nil: an inherited environment could override our config
	cmd.Dir = c.spec.Dir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// Its own process group, so a Ctrl-C in the terminal that started the supervisor does
	// not race the ordered shutdown by killing the children first.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("start %s: %w", c.spec.Name, err)
	}

	done := make(chan struct{})
	c.mu.Lock()
	c.cmd = cmd
	c.pid = cmd.Process.Pid
	c.exited = false
	c.waitDone = done
	c.exitError = nil
	c.mu.Unlock()

	if err := writePidfile(c.runner.pidPath(c.spec.Name), cmd.Process.Pid); err != nil {
		c.runner.log.Warnf("could not record the %s pid: %v", c.spec.Name, err)
	}

	go func() {
		err := cmd.Wait()
		logFile.Close()
		c.mu.Lock()
		c.exited = true
		c.exitError = err
		if err != nil && !c.stopping {
			c.lastErr = describeExit(c.spec.Name, err)
		}
		c.mu.Unlock()
		close(done)
	}()
	return nil
}

// superviseRestarts is compose's `restart: unless-stopped`. It watches for an exit that
// was not asked for and brings the service back with a growing backoff, recording each
// one — a service that keeps dying should be visible in `status`, not silently flapping.
func (c *child) superviseRestarts() {
	go func() {
		for {
			c.mu.Lock()
			done := c.waitDone
			stopping := c.stopping
			c.mu.Unlock()
			if stopping || done == nil {
				return
			}
			<-done

			c.mu.Lock()
			if c.stopping {
				c.mu.Unlock()
				return
			}
			c.restartN++
			attempt := c.restartN
			reason := c.lastErr
			c.mu.Unlock()

			delay := c.runner.restartDelay(attempt)
			c.runner.log.Warnf("%s exited unexpectedly (%s); restarting in %s (attempt %d)",
				c.spec.Name, reason, delay, attempt)
			time.Sleep(delay)

			// The stopping check and the spawn are one atomic decision: a stop() that
			// arrives between them would otherwise never learn about the new process.
			c.lifecycle.Lock()
			c.mu.Lock()
			stopping = c.stopping
			c.mu.Unlock()
			if stopping {
				c.lifecycle.Unlock()
				return
			}
			err := c.spawn()
			c.lifecycle.Unlock()
			if err != nil {
				c.runner.log.Errorf("could not restart %s: %v", c.spec.Name, err)
				c.mu.Lock()
				c.lastErr = err.Error()
				c.mu.Unlock()
				return
			}
			c.runner.log.Infof("%s restarted (pid %d)", c.spec.Name, c.currentPid())
		}
	}()
}

// stop asks politely, then insists. A service that ignores SIGTERM must not hold up
// shutdown — the menu-bar app's "Quit" has to be quick and total.
func (c *child) stop(grace time.Duration) error {
	// Under lifecycle, so a crash-restart is either not yet started (it will see
	// stopping and give up) or fully published (cmd below is that new process). The
	// lock is released before any waiting: stop must never block a spawn it is about
	// to kill, and holding it across a 15s grace would deadlock the supervise goroutine.
	c.lifecycle.Lock()
	c.mu.Lock()
	c.stopping = true
	cmd, done := c.cmd, c.waitDone
	c.mu.Unlock()
	c.lifecycle.Unlock()

	defer os.Remove(c.runner.pidPath(c.spec.Name))

	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if !c.running() {
		return nil
	}

	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
		return nil
	case <-time.After(grace):
	}

	c.runner.log.Warnf("%s ignored SIGTERM after %s; killing it", c.spec.Name, grace)
	_ = cmd.Process.Kill()
	select {
	case <-done:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("%s (pid %d) did not exit after SIGKILL", c.spec.Name, c.currentPid())
	}
}

func (c *child) running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cmd != nil && !c.exited
}

func (c *child) currentPid() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pid
}

func (c *child) restarts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.restartN
}

func (c *child) lastError() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastErr
}

// liveness is the callback waitHTTP uses to fail fast instead of waiting out the full
// health timeout on a process that is already gone.
func (c *child) liveness() func() error {
	return func() error {
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.exited {
			return nil
		}
		reason := c.lastErr
		if reason == "" {
			reason = "it exited"
		}
		return fmt.Errorf("%s is not running: %s — see %s", c.spec.Name, reason, c.runner.logPath(c.spec.Name))
	}
}

func describeExit(name string, err error) string {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Sprintf("%s exited with status %d", name, exitErr.ExitCode())
	}
	return fmt.Sprintf("%s exited: %v", name, err)
}

// Log rotation, per plan §3 ("one file per service, rotated"). A Mac mini that is never
// rebooted would otherwise grow a PowerSync log without bound. One generation is kept:
// enough to still have the run before the current one when something goes wrong,
// without turning the data directory into a log archive.
const (
	maxLogBytes    = 10 << 20 // 10 MiB
	rotatedLogKept = 1
)

// rotateIfLarge is called at spawn — including every restart — so a crash-looping
// service cannot fill the disk between checks.
func rotateIfLarge(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if st.Size() < maxLogBytes {
		return nil
	}
	previous := path + ".1"
	if rotatedLogKept > 0 {
		// Rename rather than copy: any writer still holding the old descriptor keeps
		// writing to the rotated file, which is the correct place for its output.
		return os.Rename(path, previous)
	}
	return os.Remove(path)
}

func writePidfile(path string, pid int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strconv.Itoa(pid)+"\n"), 0o600)
}

func readPidfile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0, fmt.Errorf("%s does not contain a pid: %w", path, err)
	}
	if pid <= 0 {
		return 0, fmt.Errorf("%s contains an implausible pid %d", path, pid)
	}
	return pid, nil
}

// processAlive answers "is this pid running" for a process this program did not spawn —
// which is how `status` and `stop` work across invocations. Signal 0 performs the
// permission and existence checks without delivering anything.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	// EPERM means it exists but belongs to someone else.
	return errors.Is(err, syscall.EPERM)
}

func signalPid(pid int, sig syscall.Signal) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(sig)
}
