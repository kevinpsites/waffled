package supervisor

import (
	"context"
	"errors"
	"io"
	"os/exec"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// AdminIO is the caller's own stdio, wired straight through to the operator CLI. It is
// passed rather than assumed so a test can drive the command without a terminal — and so
// that in production the child sees the real one: admin.js refuses every destructive
// command without an interactive stdin, and captured output would make each of them
// unanswerable.
type AdminIO struct {
	In       io.Reader
	Out, Err io.Writer
}

// Admin runs the bundle's break-glass operator CLI against this household's database and
// returns the exit code it finished with — the native form of Docker's
// `docker exec waffled-api node dist/admin.js …`.
//
// It brings Postgres up on its own if the server is stopped, the way `backup` does: being
// locked out of the web UI is the usual reason to be here, and "start the whole server
// first" is a poor answer to "no one can sign in". A machine where Waffled has never run
// is refused by requireCluster instead, in those words.
func (s *Supervisor) Admin(ctx context.Context, args []string, stdio AdminIO) (int, error) {
	stop, err := s.ensurePostgres(ctx)
	if err != nil {
		return 0, err
	}
	defer stop()

	err = s.runStreaming(ctx, s.plan.Admin(args), stdio)
	// The CLI has already said why, in its own words and its own colours; repeating
	// "exit status 1" over the top of it would only bury the sentence that matters.
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return normalizeExitCode(exit.ExitCode()), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, nil
}

// normalizeExitCode turns "killed by a signal" (-1) into a code a shell can carry.
func normalizeExitCode(code int) int {
	if code < 0 {
		return 1
	}
	return code
}

// runStreaming runs a command with the caller's stdio attached and no deadline of its own.
// The neighbouring one-shots capture output under a timeout, which is right for psql and
// wrong here: the person on the other end is reading a y/N prompt, and any timeout we
// picked would be a guess at how long they take to decide.
func (s *Supervisor) runStreaming(ctx context.Context, spec services.Spec, stdio AdminIO) error {
	cmd := exec.CommandContext(ctx, spec.Path)
	cmd.Args = spec.Args
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdio.In, stdio.Out, stdio.Err
	return cmd.Run()
}
