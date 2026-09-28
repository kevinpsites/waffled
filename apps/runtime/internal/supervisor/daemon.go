package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// The daemonize decision, in one place.
//
// The supervisor's real mode is FOREGROUND: `start --foreground` runs the whole
// supervision loop in this process, holds the children, and shuts them down in order on
// SIGTERM/SIGINT. That is what launchd wants (launchd supervises a foreground child and
// gets confused by a process that forks away), and it is what the integration test and
// the menu-bar app drive.
//
// `start` without --foreground is a convenience for someone in Terminal: it re-execs
// THIS binary with --foreground in a new session, so the stack outlives the shell. It is
// a re-exec rather than a fork because Go's runtime is multithreaded by the time main
// runs and the classic double-fork is not safe after that point.
//
// Either way the supervisor writes pids/supervisor.pid, and `stop` signals it — so stop
// works identically whether the stack was started by launchd, by the app, or by hand.

// RunForeground starts the stack and blocks until the process is asked to stop, then
// shuts it down in reverse order. This is the only place that supervises.
func (s *Supervisor) RunForeground(ctx context.Context) error {
	pidPath := s.runner.pidPath(SupervisorPidName)
	if pid, err := readPidfile(pidPath); err == nil && processAlive(pid) && pid != os.Getpid() {
		return fmt.Errorf("another waffled-runtime is already supervising %s (pid %d)", s.plan.Layout.Root, pid)
	}
	if err := writePidfile(pidPath, os.Getpid()); err != nil {
		return fmt.Errorf("record the supervisor pid: %w", err)
	}
	defer os.Remove(pidPath)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)

	startErr := s.Start(ctx)
	if startErr != nil {
		// Leave nothing half-running behind a failed start.
		stopCtx, stopCancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		_ = s.Stop(stopCtx)
		stopCancel()
		return startErr
	}

	select {
	case sig := <-signals:
		s.log.Infof("received %s — shutting down", sig)
	case <-ctx.Done():
		s.log.Infof("shutting down")
	}

	// Shutdown gets its own deadline: the context that told us to stop is already done.
	stopCtx, stopCancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer stopCancel()
	return s.Stop(stopCtx)
}

// StartDetached re-execs this binary with --foreground in its own session and waits for
// the stack to report healthy, so `waffled-runtime start` in a Terminal returns only
// once the server is actually usable — or fails with the reason.
func (s *Supervisor) StartDetached(ctx context.Context, extraArgs []string) (int, error) {
	if pid, err := readPidfile(s.runner.pidPath(SupervisorPidName)); err == nil && processAlive(pid) {
		return pid, fmt.Errorf("waffled-runtime is already running for %s (pid %d)", s.plan.Layout.Root, pid)
	}

	exe, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("locate this binary: %w", err)
	}
	args := append([]string{
		"start", "--foreground",
		"--bundle", s.plan.Bundle,
		"--data", s.plan.Layout.Root,
	}, extraArgs...)

	logPath := s.plan.Layout.LogPath("runtime")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", logPath, err)
	}
	defer logFile.Close()

	cmd := exec.Command(exe, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	// Setsid detaches from the controlling terminal, so closing the Terminal window (or
	// Ctrl-C in it) does not take the household's server down with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start the supervisor: %w", err)
	}
	pid := cmd.Process.Pid
	// Nothing waits on this child on purpose — it is meant to outlive us. Release it so
	// it is reparented rather than left a zombie when we exit.
	go func() { _ = cmd.Wait() }()

	s.log.Infof("supervisor started (pid %d); logging to %s", pid, logPath)
	return pid, s.waitUntilHealthy(ctx, pid, 3*time.Minute)
}

// waitUntilHealthy polls the same public health endpoint a browser would, and gives up
// early if the supervisor it is waiting on has died.
func (s *Supervisor) waitUntilHealthy(ctx context.Context, supervisorPid int, timeout time.Duration) error {
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", s.plan.Ports.Public)
	alive := func() error {
		if processAlive(supervisorPid) {
			return nil
		}
		return fmt.Errorf("the supervisor exited during startup — see %s", s.plan.Layout.LogPath("runtime"))
	}
	return waitHTTP(ctx, url, timeout, alive)
}

// StopDetached signals a supervisor started earlier and waits for it to finish its
// ordered shutdown. When no supervisor is running it falls back to stopping whatever
// services are still up, so a half-dead stack can always be cleaned up.
func (s *Supervisor) StopDetached(ctx context.Context, timeout time.Duration) error {
	pidPath := s.runner.pidPath(SupervisorPidName)
	pid, err := readPidfile(pidPath)
	if err != nil || !processAlive(pid) {
		if err == nil {
			_ = os.Remove(pidPath)
		}
		s.log.Infof("no supervisor is running; stopping any services left behind")
		return s.Stop(ctx)
	}

	s.log.Infof("stopping the supervisor (pid %d)", pid)
	if err := signalPid(pid, syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("signal the supervisor: %w", err)
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			s.log.Infof("stopped")
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}

	s.log.Warnf("the supervisor did not exit within %s; killing it and stopping services directly", timeout)
	_ = signalPid(pid, syscall.SIGKILL)
	_ = os.Remove(pidPath)
	return s.Stop(ctx)
}
