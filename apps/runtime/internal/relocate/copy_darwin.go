package relocate

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// dittoPath is absolute so the copy does not depend on whatever PATH the app was launched
// with. It is part of the OS, not something a household installs.
const dittoPath = "/usr/bin/ditto"

// copyTree is `ditto` on macOS: it preserves the extended attributes, ACLs and hard links
// a Postgres cluster and a media folder carry, including the Time Machine exclusion on
// postgres/ — which is the whole reason not to hand-roll a walk here. `ditto A B` copies
// the CONTENTS of A into B, which is the shape this wants.
func copyTree(ctx context.Context, src, dst string) error {
	cmd := exec.CommandContext(ctx, dittoPath, src, dst)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if detail := strings.TrimSpace(string(out)); detail != "" {
		return fmt.Errorf("%w: %s", err, detail)
	}
	return err
}
