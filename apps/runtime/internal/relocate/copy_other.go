//go:build !darwin

package relocate

import "context"

// copyTree off macOS is the portable walk. The runtime only ships on macOS today; this
// exists so the package builds and tests under `GOOS=linux`, which CI does on every PR.
func copyTree(ctx context.Context, src, dst string) error {
	return copyGeneric(ctx, src, dst)
}
