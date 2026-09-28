package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// safeBuffer is written by the follower goroutine and read by the test.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func appendLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(line); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func waitForText(t *testing.T, b *safeBuffer, want string, limit time.Duration) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if bytes.Contains([]byte(b.String()), []byte(want)) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("never saw %q in the followed output after %s; got:\n%s", want, limit, b.String())
}

// startFollower runs followFile against path and returns the output and a stop func.
// It does not return until the follower is attached: followFile seeks to the end on
// open, so anything the test writes before then would legitimately be skipped.
func startFollower(t *testing.T, path string) (*safeBuffer, func()) {
	t.Helper()
	out := &safeBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := followFile(ctx, path, out, 5*time.Millisecond); err != nil {
			t.Errorf("followFile: %v", err)
		}
	}()
	stop := func() {
		cancel()
		<-done
	}

	deadline := time.Now().Add(2 * time.Second)
	for !bytes.Contains([]byte(out.String()), []byte("follower-attached")) {
		if time.Now().After(deadline) {
			stop()
			t.Fatal("the follower never attached to the log")
		}
		appendLine(t, path, "follower-attached\n")
		time.Sleep(5 * time.Millisecond)
	}
	return out, stop
}

// `logs -f` must keep working across a log rotation. rotateIfLarge renames the log and
// the restarted service opens a fresh one at the same name; a follower that only seeks
// on its existing descriptor re-reads the renamed inode and never sees another line.
func TestFollowFileSurvivesRotationToASmallerFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "api.log")
	appendLine(t, path, "before rotation, a good long line of earlier output\n")

	out, stop := startFollower(t, path)
	t.Cleanup(stop)

	appendLine(t, path, "line while still on the first file\n")
	waitForText(t, out, "line while still on the first file", 2*time.Second)

	// Rotation: rename the file away and let the service open a fresh one.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	appendLine(t, path, "after rotation\n")

	waitForText(t, out, "after rotation", 2*time.Second)
}

// The harder case the size check alone cannot catch: the replacement file has already
// grown past the offset the follower held, so `st.Size() < offset` is false and only
// os.SameFile reveals that this is a different file.
func TestFollowFileSurvivesRotationToAFileAlreadyPastTheOldOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "api.log")
	appendLine(t, path, "short first generation\n")

	out, stop := startFollower(t, path)
	t.Cleanup(stop)

	appendLine(t, path, "still the first file\n")
	waitForText(t, out, "still the first file", 2*time.Second)

	// Replace it in one step, with more bytes than the follower's offset, so the new
	// file never looks smaller than the old one.
	replacement := filepath.Join(dir, "staged")
	body := bytes.Repeat([]byte("padding so the new file is bigger than the old offset\n"), 40)
	if err := os.WriteFile(replacement, append(body, []byte("after the big rotation\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}

	waitForText(t, out, "after the big rotation", 2*time.Second)
}
