package relocate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The old folder failing to go is not a failed move — the household is whole at the new
// address. Reported as a plain failure it strands them: whoever asked keeps pointing at
// the old folder, and a retry is then refused because the destination "already has
// something in it". So the error is distinguishable, and the plan comes back with it.
func TestAMoveThatCouldNotRemoveTheOldFolderStillReportsWhereItWent(t *testing.T) {
	l := household(t)
	to := filepath.Join(t.TempDir(), "Waffled")

	o := options(l, to)
	// A copy that succeeds, then a source that cannot be removed — the shape of a
	// permission problem or a file another process is holding open.
	o.Copy = func(ctx context.Context, src, dst string) error {
		if err := copyGeneric(ctx, src, dst); err != nil {
			return err
		}
		// Make the parent un-writable so RemoveAll of the source fails.
		return os.Chmod(filepath.Dir(src), 0o500)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Dir(l.Root), 0o700) })

	plan, err := Run(context.Background(), o)
	if err == nil {
		t.Skip("this filesystem removed the folder anyway; nothing to assert")
	}
	if !errors.Is(err, ErrOldFolderRemains) {
		t.Fatalf("want ErrOldFolderRemains so a caller can tell this apart, got %v", err)
	}
	if plan.To != to {
		t.Errorf("the plan must still say where the household went, got %+v", plan)
	}
	// And it really did arrive.
	if _, statErr := os.Stat(filepath.Join(to, "config.env")); statErr != nil {
		t.Errorf("the household should be whole at the new address: %v", statErr)
	}
}

// Every other failure stays a failure — the sentinel must not swallow real ones.
func TestARealFailureIsNotMistakenForTheOldFolderRemaining(t *testing.T) {
	l := household(t)
	o := options(l, filepath.Join(t.TempDir(), "Waffled"))
	o.Copy = func(_ context.Context, _, _ string) error { return errors.New("the disk gave up") }

	_, err := Run(context.Background(), o)
	if err == nil {
		t.Fatal("a copy that failed must be reported")
	}
	if errors.Is(err, ErrOldFolderRemains) {
		t.Error("a failed copy is not a move whose cleanup fell short")
	}
}
