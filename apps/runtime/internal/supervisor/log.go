package supervisor

import (
	"fmt"
	"io"
	"sync"
	"time"
)

// Logger is the supervisor's own log — deliberately plain text, because the people who
// read it are an operator tailing a file and a support conversation, not a log pipeline.
// Per-service output goes to logs/<svc>.log untouched; this is the narrative of what the
// supervisor decided and when.
type Logger struct {
	mu     sync.Mutex
	w      io.Writer
	quiet  bool
	prefix string
}

// NewLogger writes to w. When quiet, informational lines are dropped and only warnings
// and errors survive — what `status --json` and the menu-bar app want.
func NewLogger(w io.Writer, quiet bool) *Logger {
	return &Logger{w: w, quiet: quiet}
}

func (l *Logger) write(level, format string, args ...any) {
	if l == nil || l.w == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s %-5s %s%s\n",
		time.Now().Format("2006-01-02 15:04:05"), level, l.prefix, fmt.Sprintf(format, args...))
}

// Infof records normal progress.
func (l *Logger) Infof(format string, args ...any) {
	if l != nil && l.quiet {
		return
	}
	l.write("info", format, args...)
}

// Warnf records something the operator should know but that did not stop the start.
func (l *Logger) Warnf(format string, args ...any) { l.write("warn", format, args...) }

// Errorf records a failure.
func (l *Logger) Errorf(format string, args ...any) { l.write("error", format, args...) }
