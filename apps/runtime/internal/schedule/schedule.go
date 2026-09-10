// Package schedule installs the nightly backup as a launchd user agent.
//
// A user agent, not a daemon: it needs no admin prompt, it runs as the person who owns
// the data directory (so the dump lands with the right ownership), and it is the same
// mechanism plan §5 chose for the login item. The cost is that it only fires while
// someone is logged in — which is the documented Mac-mini-with-auto-login story, and the
// reason `backup` can start Postgres for itself rather than assuming the stack is up.
package schedule

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
)

// Label is the launchd job label. The plist filename must match it.
const Label = "app.waffled.backup"

// Agent is one installable schedule. Every path is explicit rather than derived at
// install time so the tests can point it at a temp directory: nothing here may write
// into the real ~/Library/LaunchAgents or run launchctl during `go test`.
type Agent struct {
	// AgentsDir is ~/Library/LaunchAgents in production.
	AgentsDir string
	// BinaryPath is the absolute path to waffled-runtime. A launchd agent gets a minimal
	// environment and no useful working directory, so nothing may be resolved from PATH.
	BinaryPath string
	BundleDir  string
	DataDir    string
	LogPath    string
	// At is the local 24-hour time the nightly backup runs, "HH:MM". Empty means
	// DefaultHour:DefaultMinute — a string rather than two ints so that a household
	// choosing midnight is not read as one that chose nothing.
	At string
	// UID is the user's, for the gui/<uid> domain launchctl bootstraps into.
	UID int

	// launchctl is a field so the tests can record calls instead of scheduling a real
	// nightly job on whatever machine runs the suite.
	launchctl func(args ...string) (string, error)
}

// For builds the agent for a data directory and the binary currently running.
func For(binaryPath, bundleDir, dataDir, logPath string) (*Agent, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate the home directory: %w", err)
	}
	return &Agent{
		AgentsDir:  filepath.Join(home, "Library", "LaunchAgents"),
		BinaryPath: binaryPath,
		BundleDir:  bundleDir,
		DataDir:    dataDir,
		LogPath:    logPath,
		UID:        os.Getuid(),
	}, nil
}

// PlistPath is where the agent lives. launchd matches the filename against the Label.
func (a *Agent) PlistPath() string {
	return filepath.Join(a.AgentsDir, Label+".plist")
}

// Installed reports whether the plist is in place. It is deliberately a filesystem
// question rather than a `launchctl print` one: `status` asks it on every poll, and
// spawning launchctl for that would be a process per second for the menu-bar app.
func (a *Agent) Installed() bool {
	_, err := os.Stat(a.PlistPath())
	return err == nil
}

// Install writes the plist and loads it. Idempotent: launchd refuses to bootstrap a
// label it already holds, so an existing job is booted out first — re-running the
// command, or an update re-asserting the schedule, is the normal case.
func (a *Agent) Install() error {
	body, err := a.Plist()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(a.AgentsDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", a.AgentsDir, err)
	}
	// 0644, not 0600: launchd refuses a job file that is group- or world-writable, and
	// there is nothing secret in it — the secrets stay in config.env.
	//
	// Written atomically — temp file, fsync, rename — like every other file this runtime
	// owns. A crash or power loss part-way through a bare write leaves a truncated plist
	// that launchd refuses at the next login, while Installed() (a bare os.Stat) goes on
	// reporting a nightly backup that can never run.
	if err := atomicfile.WriteFile(a.PlistPath(), body, 0o644); err != nil {
		return err
	}
	// Best-effort: bootout fails when nothing is loaded, which is the common case.
	_, _ = a.run("bootout", a.domainTarget())
	if out, err := a.run("bootstrap", a.domain(), a.PlistPath()); err != nil {
		// The plist goes with it. Installed() is a bare os.Stat, so a file left behind by
		// a bootstrap that failed would have `doctor`, `status` and the menu bar all
		// reporting a nightly backup indefinitely while launchd holds no job and nothing
		// ever runs. Removing it is not destructive: bootout above already unloaded
		// whatever was there, so by this point the file describes nothing.
		if rerr := os.Remove(a.PlistPath()); rerr != nil && !os.IsNotExist(rerr) {
			return fmt.Errorf("launchctl bootstrap %s: %w\n%s\n(and %s could not be removed: %v)",
				a.PlistPath(), err, strings.TrimSpace(out), a.PlistPath(), rerr)
		}
		return fmt.Errorf("launchctl bootstrap %s: %w\n%s", a.PlistPath(), err, strings.TrimSpace(out))
	}
	return nil
}

// Loaded asks launchd whether the job is actually there, by exit status rather than by
// parsing output. It is the cross-check `doctor` runs and deliberately not what
// Installed() asks: a plist can be on disk with no job loaded — a bootstrap that failed
// on an older build, a label booted out by hand — and only launchd knows the difference.
//
// It is a process fork, so nothing that polls may call it. `status` and the menu bar
// stay on Installed().
func (a *Agent) Loaded() (bool, error) {
	out, err := a.run("print", a.domainTarget())
	if err == nil {
		return true, nil
	}
	// launchctl's own words: "Could not find service … in domain" is a job that is not
	// loaded, anything else is a launchctl that would not run, and `doctor` prints the
	// difference rather than guessing at it.
	if detail := strings.TrimSpace(out); detail != "" {
		return false, fmt.Errorf("launchctl print %s: %w\n%s", a.domainTarget(), err, detail)
	}
	return false, fmt.Errorf("launchctl print %s: %w", a.domainTarget(), err)
}

// ScheduledDataDir reports which data directory the installed plist backs up, read out of
// its own ProgramArguments. Empty when nothing is installed, the file cannot be parsed,
// or it carries no --data.
//
// The label is global: one Mac holds one nightly backup, belonging to whichever data
// directory installed it. Anything deciding whether that schedule is *theirs* to remove
// has to ask this rather than trust the plist's presence.
func (a *Agent) ScheduledDataDir() (string, error) {
	raw, err := os.ReadFile(a.PlistPath())
	if err != nil {
		return "", err
	}
	args, err := programArguments(raw)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", a.PlistPath(), err)
	}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--data" {
			return args[i+1], nil
		}
	}
	return "", fmt.Errorf("%s names no --data directory", a.PlistPath())
}

// programArguments pulls the ProgramArguments array back out of a plist. It reads the
// token stream rather than matching strings so that the XML escaping Plist() applies —
// the whole reason that function marshals instead of concatenating — is undone the same
// way launchd would undo it.
func programArguments(raw []byte) ([]string, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var (
		out        []string
		lastKey    string
		cur        string
		inKey      bool
		inString   bool
		collecting bool
	)
	for {
		tok, err := dec.Token()
		if err != nil {
			// Reaching the end without ever closing the array means the file is
			// truncated or malformed. Returning what accumulated so far would hand back
			// half a path with the confidence of a whole one.
			return nil, fmt.Errorf("no complete ProgramArguments array: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "key":
				inKey, lastKey = true, ""
			case "array":
				collecting = lastKey == "ProgramArguments"
			case "string":
				inString, cur = true, ""
			}
		case xml.CharData:
			// Accumulated, not appended: a comment or CDATA inside an element splits its
			// text across several tokens, and appending each would turn one path into
			// several arguments — silently truncating it.
			if inKey {
				lastKey += string(t)
			}
			if collecting && inString {
				cur += string(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "key":
				inKey = false
			case "string":
				if collecting && inString {
					out = append(out, cur)
				}
				inString = false
			case "array":
				if collecting {
					return out, nil
				}
			}
		}
	}
}

// Uninstall unloads the job and removes the plist. Quiet when nothing is installed —
// that is what a user does after an uninstall, and what an updater does defensively.
func (a *Agent) Uninstall() error {
	_, _ = a.run("bootout", a.domainTarget())
	if err := os.Remove(a.PlistPath()); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s: %w", a.PlistPath(), err)
	}
	return nil
}

func (a *Agent) domain() string       { return fmt.Sprintf("gui/%d", a.UID) }
func (a *Agent) domainTarget() string { return fmt.Sprintf("gui/%d/%s", a.UID, Label) }

func (a *Agent) run(args ...string) (string, error) {
	if a.launchctl != nil {
		return a.launchctl(args...)
	}
	out, err := exec.Command("/bin/launchctl", args...).CombinedOutput()
	return string(out), err
}

// Plist renders the launchd job.
//
// It is marshalled through encoding/xml rather than assembled from strings: a data
// directory under /Users/sam & jo, or an apostrophe in a user's name, would otherwise
// produce a plist that launchd silently refuses to parse and a nightly backup that never
// runs with nothing to show for it.
func (a *Agent) Plist() ([]byte, error) {
	args := []string{a.BinaryPath, "backup"}
	if a.BundleDir != "" {
		args = append(args, "--bundle", a.BundleDir)
	}
	if a.DataDir != "" {
		args = append(args, "--data", a.DataDir)
	}

	d := dict{}
	d.str("Label", Label)
	d.arr("ProgramArguments", args)
	// RunAtLoad false: installing the schedule must not kick off a dump on the spot, and
	// neither should every login.
	d.boolean("RunAtLoad", false)
	hour, minute, err := a.at()
	if err != nil {
		return nil, err
	}
	d.raw("StartCalendarInterval", dict{}.intPair("Hour", hour, "Minute", minute))
	if a.LogPath != "" {
		// Both streams go to one file. A nightly backup that fails silently is the whole
		// failure mode this schedule exists to avoid.
		d.str("StandardOutPath", a.LogPath)
		d.str("StandardErrorPath", a.LogPath)
	}
	// The dump can take a while on a large household; launchd should not consider the
	// job wedged and kill it partway through writing a file.
	d.boolean("AbandonProcessGroup", false)

	body, err := xml.MarshalIndent(plistDoc{Version: "1.0", Body: d}, "", "\t")
	if err != nil {
		return nil, fmt.Errorf("render the launchd plist: %w", err)
	}
	header := xml.Header +
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" " +
		"\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
	return append([]byte(header), append(selfCloseBooleans(body), '\n')...), nil
}

// selfCloseBooleans rewrites `<false></false>` as `<false/>`.
//
// Not cosmetic: launchd refuses the long spelling. `launchctl bootstrap` answers
// "Bootstrap failed: 5: Input/output error" and loads nothing, so the nightly backup is
// never scheduled — measured on macOS 15.7 against two dictionaries that `plutil -lint`
// and every plist reader here call identical. encoding/xml always writes the long form
// for an empty element and offers no way to ask for the short one, so this is done to the
// bytes. `<true>`/`<false>` are the only empty elements this plist has.
func selfCloseBooleans(body []byte) []byte {
	body = bytes.ReplaceAll(body, []byte("<false></false>"), []byte("<false/>"))
	return bytes.ReplaceAll(body, []byte("<true></true>"), []byte("<true/>"))
}

// The minimum of the plist XML grammar this one job needs. Property lists are an ordered
// sequence of alternating <key> and value elements, which no Go struct maps onto
// directly, so the elements are emitted in order as raw tokens.
type plistDoc struct {
	XMLName xml.Name `xml:"plist"`
	Version string   `xml:"version,attr"`
	Body    dict     `xml:"dict"`
}

type element struct {
	key   string
	value any // string | bool | []string | dict
}

type dict []element

func (d *dict) str(k, v string)          { *d = append(*d, element{k, v}) }
func (d *dict) boolean(k string, v bool) { *d = append(*d, element{k, v}) }
func (d *dict) arr(k string, v []string) { *d = append(*d, element{k, v}) }
func (d *dict) raw(k string, v dict)     { *d = append(*d, element{k, v}) }

// intPair builds the two-entry dict StartCalendarInterval takes.
func (dict) intPair(k1 string, v1 int, k2 string, v2 int) dict {
	return dict{{k1, v1}, {k2, v2}}
}

// MarshalXML writes the dict's entries in order, each as <key>…</key> followed by its
// typed value element.
func (d dict) MarshalXML(e *xml.Encoder, start xml.StartElement) error {
	start.Name = xml.Name{Local: "dict"}
	if err := e.EncodeToken(start); err != nil {
		return err
	}
	for _, el := range d {
		if err := e.EncodeElement(el.key, xml.StartElement{Name: xml.Name{Local: "key"}}); err != nil {
			return err
		}
		if err := encodeValue(e, el.value); err != nil {
			return err
		}
	}
	return e.EncodeToken(start.End())
}

func encodeValue(e *xml.Encoder, v any) error {
	switch t := v.(type) {
	case string:
		return e.EncodeElement(t, xml.StartElement{Name: xml.Name{Local: "string"}})
	case int:
		return e.EncodeElement(t, xml.StartElement{Name: xml.Name{Local: "integer"}})
	case bool:
		name := "false"
		if t {
			name = "true"
		}
		el := xml.StartElement{Name: xml.Name{Local: name}}
		if err := e.EncodeToken(el); err != nil {
			return err
		}
		return e.EncodeToken(el.End())
	case []string:
		el := xml.StartElement{Name: xml.Name{Local: "array"}}
		if err := e.EncodeToken(el); err != nil {
			return err
		}
		for _, s := range t {
			if err := e.EncodeElement(s, xml.StartElement{Name: xml.Name{Local: "string"}}); err != nil {
				return err
			}
		}
		return e.EncodeToken(el.End())
	case dict:
		return e.EncodeElement(t, xml.StartElement{Name: xml.Name{Local: "dict"}})
	default:
		return fmt.Errorf("unsupported plist value %T", v)
	}
}
