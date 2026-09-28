package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// uninstallSandbox is a data directory nothing else is using, with HOME pointed at a
// temp directory so the launchd agent this command builds can only ever look at — and
// never find — a plist in there. The real ~/Library/LaunchAgents is untouchable from
// here.
func uninstallSandbox(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), "Waffled")
	for rel, body := range map[string]string{
		"config.env":          "LOCAL_JWT_SECRET=abc\n",
		"postgres/PG_VERSION": "16\n",
		"media/photo.jpg":     strings.Repeat("j", 2048),
	} {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// captureStdout runs fn with os.Stdout redirected and returns what it printed.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	return capture(t, &os.Stdout, fn)
}

// captureStderr is captureStdout for os.Stderr.
func captureStderr(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	return capture(t, &os.Stderr, fn)
}

func capture(t *testing.T, stream **os.File, fn func() error) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := *stream
	*stream = w

	// Drained concurrently: a pipe holds only 64 KB, and a command that printed more
	// than that would block forever instead of failing the test.
	drained := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		drained <- string(out)
	}()

	runErr := fn()
	*stream = saved
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out := <-drained
	r.Close()
	return out, runErr
}

func TestUninstallJSONCarriesSchema1(t *testing.T) {
	root := uninstallSandbox(t)

	out, err := captureStdout(t, func() error {
		return run([]string{"uninstall", "--data", root, "--dry-run", "--json"})
	})
	if err != nil {
		t.Fatalf("uninstall --dry-run --json: %v", err)
	}

	var doc struct {
		Schema        int    `json:"schema"`
		DataDir       string `json:"dataDir"`
		DataSizeBytes int64  `json:"dataSizeBytes"`
		Items         []struct {
			Kind    string `json:"kind"`
			Path    string `json:"path"`
			Action  string `json:"action"`
			Present bool   `json:"present"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("the --json output does not decode: %v\n%s", err, out)
	}
	if doc.Schema != 1 {
		t.Errorf("schema = %d, want 1", doc.Schema)
	}
	if doc.DataDir != root {
		t.Errorf("dataDir = %q, want %q", doc.DataDir, root)
	}
	if doc.DataSizeBytes < 2048 {
		t.Errorf("dataSizeBytes = %d, want at least the 2048-byte photo", doc.DataSizeBytes)
	}
	var data struct {
		found  bool
		action string
	}
	for _, it := range doc.Items {
		if it.Kind == "data" {
			data.found, data.action = true, it.Action
		}
	}
	if !data.found {
		t.Fatalf("no data item in %s", out)
	}
	if data.action != "keep" {
		t.Errorf("data action = %q, want keep — the default must never delete the household's data", data.action)
	}
	if _, err := os.Stat(filepath.Join(root, "config.env")); err != nil {
		t.Errorf("a dry run removed something: %v", err)
	}
}

// The refusal, driven through the real command. --yes is deliberately never passed here:
// the pid in the file is this test process, and the whole point of --yes is to kill it.
func TestUninstallRefusesWhileTheServerIsRunning(t *testing.T) {
	root := uninstallSandbox(t)
	if err := os.MkdirAll(filepath.Join(root, "pids"), 0o700); err != nil {
		t.Fatal(err)
	}
	pidfile := filepath.Join(root, "pids", "supervisor.pid")
	if err := os.WriteFile(pidfile, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := captureStdout(t, func() error {
		return run([]string{"uninstall", "--data", root})
	})
	if err == nil {
		t.Fatal("uninstall succeeded while the server was running; want a refusal")
	}
	if !strings.Contains(err.Error(), "--yes") {
		t.Errorf("the refusal does not say how to proceed: %v", err)
	}
	if _, err := os.Stat(pidfile); err != nil {
		t.Errorf("the refusal still removed the pidfile: %v", err)
	}
}

// A refusal happens before anything is attempted, so it must print no report at all.
// Printing the plan there reads as a receipt for work that never happened — the
// not-a-data-directory refusal announced "your Waffled data … was deleted" and then
// refused on the next line.
func TestARefusalPrintsNoReport(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, "taxes.pdf"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := captureStdout(t, func() error {
		return run([]string{"uninstall", "--data", home, "--delete-data"})
	})
	if err == nil {
		t.Fatal("uninstall deleted a directory with nothing of Waffled's in it")
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("the refusal printed a report:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(home, "taxes.pdf")); err != nil {
		t.Errorf("the refusal still deleted the contents: %v", err)
	}
}
