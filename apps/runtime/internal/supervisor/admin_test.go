package supervisor

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// The operator CLI is interactive: it refuses every destructive command unless stdin is a
// terminal, and it prints its own diagnosis before exiting non-zero. So this runner may
// not capture output the way the psql one-shots do, and the exit code has to survive.
func TestRunStreamingPassesStdioThroughAndReportsTheExitCode(t *testing.T) {
	var out, errOut bytes.Buffer
	spec := services.Spec{
		Name: "fake-admin",
		Path: "/bin/sh",
		Args: []string{"/bin/sh", "-c", `read answer; echo "answered $answer"; echo refused >&2; exit 7`},
		Env:  []string{"PATH=/usr/bin:/bin"},
	}

	err := (&Supervisor{}).runStreaming(context.Background(), spec,
		AdminIO{In: strings.NewReader("y\n"), Out: &out, Err: &errOut})

	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("want the child's exit status, got %v", err)
	}
	if got := normalizeExitCode(exit.ExitCode()); got != 7 {
		t.Errorf("exit code = %d, want 7", got)
	}
	if !strings.Contains(out.String(), "answered y") {
		t.Errorf("stdin never reached the child: stdout = %q", out.String())
	}
	if !strings.Contains(errOut.String(), "refused") {
		t.Errorf("stderr was not streamed: %q", errOut.String())
	}
}

// A child killed by a signal reports -1, which no shell can carry. Ctrl-C during a
// confirmation prompt is the everyday way to get here.
func TestAnExitCodeAShellCannotCarryBecomesOne(t *testing.T) {
	if got := normalizeExitCode(-1); got != 1 {
		t.Errorf("normalizeExitCode(-1) = %d, want 1", got)
	}
	for _, code := range []int{0, 2, 7} {
		if got := normalizeExitCode(code); got != code {
			t.Errorf("normalizeExitCode(%d) = %d", code, got)
		}
	}
}
