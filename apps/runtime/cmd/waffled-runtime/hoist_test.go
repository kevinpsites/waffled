package main

import (
	"reflect"
	"testing"
)

// hoistFlags exists because Go's flag package stops parsing at the first non-flag word,
// so `config set KEY=V --data DIR` would otherwise write into the household's real
// config.env and report success. These are the two edges the round-1 tests did not reach.
func TestHoistFlags(t *testing.T) {
	takesValue := map[string]bool{"data": true, "bundle": true}

	for _, c := range []struct {
		name              string
		args              []string
		flags, positional []string
	}{
		{
			name:  "an assignment before the flags is still hoisted behind them",
			args:  []string{"KEY=V", "--data", "/tmp/x"},
			flags: []string{"--data", "/tmp/x"}, positional: []string{"KEY=V"},
		},
		{
			name:  "a flag carrying its own value swallows nothing after it",
			args:  []string{"--data=/tmp/x", "KEY=V"},
			flags: []string{"--data=/tmp/x"}, positional: []string{"KEY=V"},
		},
		{
			// `--` is where a person says "everything after this is a value, not a flag",
			// and a value that begins with a dash is exactly why they would.
			name:  "everything after -- is positional, dashes and all",
			args:  []string{"--data", "/tmp/x", "--", "KEY=-weird", "--not-a-flag"},
			flags: []string{"--data", "/tmp/x"}, positional: []string{"KEY=-weird", "--not-a-flag"},
		},
		{
			name:  "-- with nothing after it takes nothing with it",
			args:  []string{"KEY=V", "--"},
			flags: nil, positional: []string{"KEY=V"},
		},
		{
			// A provider key really can contain an `=`, and the flag's own value must not
			// be mistaken for one.
			name:  "a value containing = stays one argument",
			args:  []string{"ANTHROPIC_API_KEY=sk-a=b=c", "--data", "/tmp/x"},
			flags: []string{"--data", "/tmp/x"}, positional: []string{"ANTHROPIC_API_KEY=sk-a=b=c"},
		},
		{
			name:  "a value-taking flag at the very end swallows nothing that is not there",
			args:  []string{"KEY=V", "--data"},
			flags: []string{"--data"}, positional: []string{"KEY=V"},
		},
		{
			name:  "a flag that takes no value leaves the next word alone",
			args:  []string{"--dry-run", "KEY=V"},
			flags: []string{"--dry-run"}, positional: []string{"KEY=V"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			flags, positional := hoistFlags(c.args, takesValue)
			if !reflect.DeepEqual(flags, c.flags) {
				t.Errorf("flags = %q, want %q", flags, c.flags)
			}
			if !reflect.DeepEqual(positional, c.positional) {
				t.Errorf("positional = %q, want %q", positional, c.positional)
			}
		})
	}
}
