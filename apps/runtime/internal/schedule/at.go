package schedule

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// The nightly time when a household has not chosen one. 03:00 local, an hour after the
// Compose sidecar's 02:00 default so a household running both during a migration does
// not have them collide.
const (
	DefaultHour   = 3
	DefaultMinute = 0
)

// ParseAt reads the `--at HH:MM` a person typed, in 24-hour local time.
//
// It is deliberately strict rather than reaching for time.Parse: the value ends up in a
// launchd plist that nothing will ever read back and complain about, so "3pm", a
// half-typed "03:0" or a pasted non-ASCII digit has to be refused here or it becomes a
// nightly backup that silently never runs.
func ParseAt(raw string) (hour, minute int, err error) {
	h, m, found := strings.Cut(raw, ":")
	if !found {
		return 0, 0, fmt.Errorf("%q is not a time — write it as HH:MM in 24-hour form, e.g. 03:00", raw)
	}
	if hour, err = digits(h); err != nil || hour > 23 {
		return 0, 0, fmt.Errorf("%q is not a time Waffled can schedule: %q is not an hour between 00 and 23", raw, h)
	}
	if minute, err = digits(m); err != nil || minute > 59 {
		return 0, 0, fmt.Errorf("%q is not a time Waffled can schedule: %q is not a minute between 00 and 59", raw, m)
	}
	return hour, minute, nil
}

// FormatAt is the one spelling of a scheduled time — what `--at` takes, what the plist is
// read back as, and what `status --json` reports.
func FormatAt(hour, minute int) string {
	return fmt.Sprintf("%02d:%02d", hour, minute)
}

// digits accepts one or two ASCII digits and nothing else. strconv.Atoi alone would take
// "+3" and "-1", and any parser built on unicode.IsDigit would take "٣".
func digits(s string) (int, error) {
	if len(s) < 1 || len(s) > 2 {
		return 0, errors.New("not one or two digits")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errors.New("not a digit")
		}
	}
	return strconv.Atoi(s)
}

// at resolves the agent's chosen time, falling back to the default when none was set.
func (a *Agent) at() (hour, minute int, err error) {
	if a.At == "" {
		return DefaultHour, DefaultMinute, nil
	}
	return ParseAt(a.At)
}

// ScheduledAt reports the time the installed schedule actually runs, read out of the
// plist's own StartCalendarInterval.
//
// The plist is the record. Keeping the hour in a second file beside it would give a Mac
// two answers to one question the moment anybody edited either — and this one is what
// launchd obeys.
func (a *Agent) ScheduledAt() (string, error) {
	raw, err := os.ReadFile(a.PlistPath())
	if err != nil {
		return "", err
	}
	hour, minute, err := calendarInterval(raw)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", a.PlistPath(), err)
	}
	return FormatAt(hour, minute), nil
}

// calendarInterval pulls Hour and Minute back out of a plist's StartCalendarInterval.
//
// Like programArguments, it reads the token stream rather than matching strings, and it
// fails closed: a plist with no interval describes a job that runs only when launchd is
// told to, and reporting that as 00:00 would invent a nightly backup nobody has.
func calendarInterval(raw []byte) (hour, minute int, err error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	hour, minute = -1, -1
	var (
		lastKey    string
		cur        string
		inKey      bool
		inInteger  bool
		armed      bool // the StartCalendarInterval key has been seen
		collecting bool
		depth      int
	)
	for {
		tok, err := dec.Token()
		if err != nil {
			return 0, 0, fmt.Errorf("no complete StartCalendarInterval: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "key":
				inKey, lastKey = true, ""
			case "dict":
				switch {
				case collecting:
					depth++
				case armed:
					collecting, depth = true, 1
				}
			case "integer":
				inInteger, cur = true, ""
			}
		case xml.CharData:
			// Accumulated rather than assigned: a comment inside an element splits its
			// text across several tokens.
			if inKey {
				lastKey += string(t)
			}
			if collecting && inInteger {
				cur += string(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "key":
				inKey = false
				if !collecting && lastKey == "StartCalendarInterval" {
					armed = true
				}
			case "integer":
				if collecting && inInteger {
					n, convErr := strconv.Atoi(strings.TrimSpace(cur))
					if convErr != nil {
						return 0, 0, fmt.Errorf("%s is %q, which is not a number", lastKey, cur)
					}
					switch lastKey {
					case "Hour":
						hour = n
					case "Minute":
						minute = n
					}
				}
				inInteger = false
			case "dict":
				if !collecting {
					continue
				}
				depth--
				if depth > 0 {
					continue
				}
				if hour < 0 || minute < 0 {
					return 0, 0, errors.New("StartCalendarInterval names no Hour and Minute")
				}
				return hour, minute, nil
			}
		}
	}
}
