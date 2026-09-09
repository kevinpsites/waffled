// Bonjour advertisement — how a phone that has never been told an address finds this
// Mac (plan §3, Phase 2 item 2).
//
// The advertiser is an ADVISORY child: started once Caddy is answering, withdrawn first
// on the way down, and never fatal. A household whose registration failed still has a
// working server — every browser and every device typing the address in reaches it — so
// a failure here is a warning in the log and a line in `status`, never a refused start.
//
// What is advertised is the PUBLIC Caddy port, because it is the only port another
// device should reach: the api, PowerSync's own listener and Postgres are loopback
// concerns hidden behind it.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/atomicfile"
	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

const (
	// bonjourCensusTimeout bounds the household query. It is deliberately short: this
	// runs on a ticker beside a live server, and a hung psql must not still be holding
	// the goroutine when the next tick arrives.
	bonjourCensusTimeout = 5 * time.Second
)

// bonjourSetupPoll is how often an install with no household re-asks whether one has
// appeared. See startBonjour for why the polling stops the moment one has.
//
// It is a variable, not a constant, only so the integration test can watch the
// setup→named transition happen for real in seconds rather than sitting out a minute of
// wall clock. It is unexported and never written in production, so — like
// Supervisor.waitHealthy — there is no knob here that a household could trip.
var bonjourSetupPoll = 60 * time.Second

// bonjourState is what the running supervisor records about its advertisement, so that
// `status` — a different process, polled every second by the menu-bar app — can report
// it without a database query or a `ps` of dns-sd's argv.
//
// It records what was ASKED FOR. Whether it is on the network is a separate question,
// answered by the advertiser's pidfile: children are spawned into their own process group
// (see process.go), so a SIGKILLed supervisor leaves dns-sd running and mDNSResponder
// still publishing — the orphan-adoption branch in stopBonjourChild exists for exactly
// that. Setup records which of the two names was chosen, for the sake of anyone reading
// bonjour.json by hand.
//
// There is deliberately no supervisor pid here. One was written on every update and read
// by nothing, under a comment claiming `stop` used it to recognise a run that was no
// longer this one — a check that does not exist. Nothing here can serve as one either:
// the process that matters is dns-sd's, which OUTLIVES the supervisor that spawned it,
// so a stale pid would answer the ownership question exactly backwards on the one run
// where it was asked.
type bonjourState struct {
	Name      string `json:"name"`
	Port      int    `json:"port"`
	Setup     bool   `json:"setup"`
	Error     string `json:"error"`
	UpdatedAt string `json:"updatedAt"`
}

func writeBonjourState(path string, st bonjourState) error {
	st.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return atomicfile.WriteJSON(path, st, 0o600)
}

func readBonjourState(path string) (bonjourState, bool) {
	var st bonjourState
	if err := atomicfile.ReadJSON(path, &st); err != nil {
		return bonjourState{}, false
	}
	return st, true
}

// bonjourStatus renders the status block from the recorded state and whether the dns-sd
// child is actually running. The two answer different questions: the file says what was
// asked for, the running process says whether it is still on the network. The process is
// the authority on the second, including when the supervisor that started it is gone —
// dns-sd survives a SIGKILLed supervisor and keeps advertising, and reporting "nothing
// advertised" then would be a false reading at the moment it matters most.
func bonjourStatus(statePath string, childRunning bool) status.Bonjour {
	// The service type is constant and is reported even when nothing is advertising, so
	// a client always knows what to look for.
	b := status.Bonjour{Service: bonjour.ServiceType}
	st, ok := readBonjourState(statePath)
	if !ok {
		return b
	}
	b.Name = st.Name
	b.Port = st.Port
	b.Error = st.Error
	if host, err := os.Hostname(); err == nil {
		b.Host = bonjour.Host(host)
	}
	b.Advertised = childRunning && st.Error == ""
	if !b.Advertised {
		// Nothing is on the network, so nothing is named on it.
		b.Name = ""
		b.Port = 0
	}
	return b
}

// BonjourStatus is the block `status` reports.
func (s *Supervisor) BonjourStatus() status.Bonjour {
	b := bonjourStatus(s.plan.Layout.BonjourState, s.serviceRunning(services.Bonjour))
	if b.Advertised || b.Error != "" {
		return b
	}
	// A child THIS process holds knows why it is not running — a crash between restart
	// attempts, say. A `status` in another process cannot see that and correctly reports
	// only that nothing is advertised.
	s.mu.Lock()
	c := s.children[services.Bonjour]
	s.mu.Unlock()
	if c != nil {
		b.Error = c.lastError()
	}
	return b
}

// advertisement is what the last attempt put on the network — enough for the poll below
// to decide whether anything has changed since.
type advertisement struct {
	name  string
	setup bool
	// live is true when dns-sd was actually started. A failed registration still has a
	// name and a flag; what it does not have is a presence on the network.
	live bool
	// settled is true when the census behind it was a POSITIVE read of an install that
	// has at least one household. Nothing about the name can change after that without a
	// restart, which is what ends the polling below.
	settled bool
}

// computerName is asked at most ONCE per process, and only if something needs it. Asking
// costs a /usr/sbin/scutil fork with a three-second timeout, and the answer cannot change
// in a way this process should act on — a Mac renamed in Sharing preferences is picked up
// on the next start, like a renamed household is.
//
// The memo matters because the re-check poll asks what the census would advertise on
// every tick: without it, an install whose census never settles would fork scutil once a
// minute forever, which is the cost this indirection exists to avoid.
//
// It is a var so a test can count the asking. Always the real function in production.
var computerName = sync.OnceValue(bonjour.ComputerName)

// plannedAdvertisement is what a census asks for, before anything is registered.
func plannedAdvertisement(c bonjour.Census) advertisement {
	// The callback is passed, not called: a household that names itself never needs it.
	name, setup := c.Advertise(computerName)
	return advertisement{name: name, setup: setup, settled: c.Known && c.Count >= 1}
}

// startBonjour advertises the server, and is called once Caddy is healthy. It never
// returns an error: every failure is recorded and logged instead.
func (s *Supervisor) startBonjour(ctx context.Context) {
	if bonjour.Tool() == "" {
		s.recordBonjour(bonjourState{Error: "this platform has no dns-sd client, so the server is not discoverable"})
		s.log.Infof("skipping Bonjour: no dns-sd client on this platform")
		return
	}

	s.mu.Lock()
	s.bonjourStop = make(chan struct{})
	s.bonjourOnce = sync.Once{}
	stop := s.bonjourStop
	s.mu.Unlock()

	s.bonjourRefresh(ctx, stop, s.householdCensus, s.advertise)
}

// bonjourRefresh registers what the census describes and, unless that has settled the
// question for good, keeps re-asking in the background.
//
// The census and the advertise step are parameters rather than direct calls so that the
// polling decision — which has three states and used to get two of them wrong — can be
// driven through all of them in a unit test without registering anything on the real
// network. Production always passes the real pair, one line above.
func (s *Supervisor) bonjourRefresh(ctx context.Context, stop <-chan struct{},
	census func(context.Context) bonjour.Census,
	advertise func(context.Context, bonjour.Census) advertisement) {

	cur := advertise(ctx, census(ctx))
	// Polling ends only when a household is genuinely ON the network. Everything else —
	// an install with no household yet, a census psql was too busy to answer, a dns-sd
	// that failed to exec — is a state that can still change, and the old code that
	// latched on the first census left a fresh install advertising `setup=1` (or nothing
	// at all) until somebody restarted the server.
	if cur.live && cur.settled {
		return
	}
	s.bonjourWait.Add(1)
	go func() {
		defer s.bonjourWait.Done()
		s.bonjourPoll(ctx, stop, cur, census, advertise)
	}()
}

// bonjourPoll re-advertises whenever what the census now asks for differs from what is
// actually on the network.
//
// The limitation this leaves is deliberate and documented: once a household exists the
// polling stops, so renaming it later does not change what is advertised until the next
// restart.
func (s *Supervisor) bonjourPoll(ctx context.Context, stop <-chan struct{}, cur advertisement,
	census func(context.Context) bonjour.Census,
	advertise func(context.Context, bonjour.Census) advertisement) {

	ticker := time.NewTicker(bonjourSetupPoll)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		c := census(ctx)
		want := plannedAdvertisement(c)
		if cur.live && want.name == cur.name && want.setup == cur.setup {
			if want.settled {
				// On the network, under the name it will keep. Nothing left to watch.
				return
			}
			continue
		}
		// The query took time; a Stop may have arrived while it ran.
		select {
		case <-stop:
			return
		default:
		}
		s.log.Infof("re-advertising on Bonjour as %q (setup=%v)", want.name, want.setup)
		s.stopBonjourChild()
		cur = advertise(ctx, c)
		if cur.live && cur.settled {
			return
		}
	}
}

// advertise (re)registers the instance the census describes, and reports what is now on
// the network.
func (s *Supervisor) advertise(ctx context.Context, census bonjour.Census) advertisement {
	a := plannedAdvertisement(census)
	inst := bonjour.Instance{
		Name: a.name,
		Port: s.plan.Ports.Public,
		URL:  s.advertisedURL(),
		// The same accessor the downgrade guard, the snapshot names and `status` use: a
		// second copy of "what version is this" would let the TXT record and the status
		// output disagree the first time either grew a fallback.
		Version: s.bundleVersion(),
		Setup:   a.setup,
	}
	st := bonjourState{Name: inst.Name, Port: inst.Port, Setup: inst.Setup}

	if err := s.startChild(ctx, s.plan.Bonjour(inst), 0); err != nil {
		st.Error = err.Error()
		s.recordBonjour(st)
		// Warn, never fail: discovery is a convenience on top of a server that works.
		s.log.Warnf("could not advertise on Bonjour (the server is fine; devices will need the address): %v", err)
		return a
	}
	s.recordBonjour(st)
	s.log.Infof("advertising %q on %s port %d (setup=%v)", inst.Name, bonjour.ServiceType, inst.Port, a.setup)
	a.live = true
	return a
}

// bonjourMaxQuickFailures is how many immediate deaths in a row the advertiser gets
// before supervision stops restarting it. Unlike a server service, a dns-sd that cannot
// register is not going to start working on the fiftieth attempt — mDNSResponder has
// refused it — and a flap nobody caps is a loop with no one watching. Giving up is safe
// precisely because this child is advisory: the server keeps serving.
//
// It caps ONE of the two ways dns-sd fails, and it is worth being exact about which. This
// budget is spent by a child that got PAST the start window: startChild armed supervision,
// and the process then died at once, repeatedly, on its own restarts.
//
// A dns-sd that is already gone when the 500ms window closes on the FIRST attempt never
// reaches supervision at all — startChild returns an error before calling supervise, so
// this constant and the report callback are never even attached to it. That path is not
// unwatched: advertise records the reason in bonjour.json and warns, and because the
// attempt left live=false the setup poll re-advertises on its next tick. It is deliberately
// uncapped, because one attempt a minute is a pace rather than a loop and the usual cause —
// the Local Network prompt not answered yet, a mDNSResponder still coming up — is a
// condition that becomes true later, which giving up would then never notice.
const bonjourMaxQuickFailures = 5

// supervise arms restart supervision, with the advertiser's own policy attached.
//
// It is the one child whose failures another process has to learn about second-hand: the
// menu-bar app and `status` read bonjour.json, not this process's memory, so an exit that
// is only recorded in a *child struct is an exit nobody can see.
func (s *Supervisor) supervise(c *child, spec services.Spec) {
	if spec.Name == services.Bonjour {
		c.maxQuickFailures = bonjourMaxQuickFailures
		c.report = s.reportBonjourExit
	}
	c.superviseRestarts()
}

// reportBonjourExit keeps bonjour.json honest about a dns-sd that is flapping or has been
// given up on — and clears the reason once it is running again, because `status` reads
// "advertised" as "the child is running AND nothing was recorded against it".
func (s *Supervisor) reportBonjourExit(reason string, gaveUp bool) {
	if gaveUp {
		reason += " — not advertising any more; restart the server to try again"
	}
	// Read the child before taking bonjourMu. It is only needed on the recovery path
	// below, but doing it here keeps the two locks from ever nesting — no path holds s.mu
	// and then reaches for bonjourMu, and a map lookup on a child's exit is not a cost
	// worth reasoning about lock order for.
	fallback := s.advertisedByChild()

	s.bonjourMu.Lock()
	defer s.bonjourMu.Unlock()
	st, ok := readBonjourState(s.plan.Layout.BonjourState)
	if !ok {
		// The file is gone or unreadable — the first writeBonjour only warned, or
		// something removed it mid-run. Returning here dropped the single fact this
		// callback exists to carry: `status` is a different process with nothing else to
		// read, and bonjourRefresh stops polling once an advertisement has settled, so a
		// child that had been given up on would report as "not advertising" with an empty
		// reason for the rest of the run. A fresh record saying only why is worth more
		// than silence.
		st = fallback
		s.bonjourMissingOnce.Do(func() {
			s.log.Warnf("%s was missing when the advertiser failed, so the reason is being recorded in a fresh one: %s",
				s.plan.Layout.BonjourState, reason)
		})
	}
	st.Error = reason
	s.writeBonjour(st)
}

// advertisedByChild recovers what is being advertised from the argv of the child holding
// it. It is the fallback for a lost bonjour.json, and never the primary source: the file
// records what was ASKED FOR, including the attempts that never got a child at all.
func (s *Supervisor) advertisedByChild() bonjourState {
	s.mu.Lock()
	c := s.children[services.Bonjour]
	s.mu.Unlock()
	if c == nil {
		return bonjourState{}
	}
	name, port, ok := bonjour.NameAndPort(c.spec.Args)
	if !ok {
		return bonjourState{}
	}
	return bonjourState{Name: name, Port: port}
}

func (s *Supervisor) recordBonjour(st bonjourState) {
	s.bonjourMu.Lock()
	defer s.bonjourMu.Unlock()
	s.writeBonjour(st)
}

// writeBonjour records the state; the caller holds bonjourMu. Two goroutines write this
// file — the refresh poll and the restart supervisor's report — and atomicfile prevents a
// torn file, not a lost update.
func (s *Supervisor) writeBonjour(st bonjourState) {
	if err := writeBonjourState(s.plan.Layout.BonjourState, st); err != nil {
		s.log.Warnf("could not record the Bonjour advertisement: %v", err)
	}
}

// stopBonjour withdraws the advertisement. Killing dns-sd is what deregisters the
// service — mDNSResponder drops a registration when the client that made it goes away —
// so this is the whole of "stop advertising".
//
// The refresh goroutine is stopped and waited for FIRST: it may be in the middle of
// deciding to restart the child, and a stop that raced it could leave a fresh dns-sd
// advertising a server that is shutting down.
func (s *Supervisor) stopBonjour() {
	s.mu.Lock()
	stop := s.bonjourStop
	once := &s.bonjourOnce
	s.mu.Unlock()
	if stop != nil {
		// Idempotent: RunForeground calls Stop on a failed start, and the integration
		// harness calls it again from t.Cleanup.
		once.Do(func() { close(stop) })
	}
	s.bonjourWait.Wait()

	s.stopBonjourChild()
	_ = os.Remove(s.plan.Layout.BonjourState)
}

func (s *Supervisor) stopBonjourChild() {
	s.mu.Lock()
	c := s.children[services.Bonjour]
	delete(s.children, services.Bonjour)
	s.mu.Unlock()
	if c != nil {
		s.log.Infof("withdrawing the Bonjour advertisement")
		if err := c.stop(stopGrace); err != nil {
			s.log.Warnf("%v", err)
		}
		return
	}
	if s.serviceRunning(services.Bonjour) {
		s.log.Infof("withdrawing the Bonjour advertisement left by a previous run")
		if err := s.stopOrphan(services.Bonjour); err != nil {
			s.log.Warnf("%v", err)
		}
	}
}

// advertisedURL is the address to put in the TXT record. The LAN address is the useful
// one; when this Mac has none, the multicast hostname is still resolvable by whoever
// found the advertisement in the first place.
func (s *Supervisor) advertisedURL() string {
	if lan := s.LANURL(); lan != "" {
		return lan
	}
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	if h := bonjour.Host(host); h != "" {
		return "http://" + h + ":" + strconv.Itoa(s.plan.Ports.Public)
	}
	return ""
}

// householdCensus asks the database how many households this install has. A failure is
// "unknown", never "none": `setup=1` tells a phone to go and finish setup on the Mac,
// and a busy psql is not a reason to send someone back to a wizard they completed.
func (s *Supervisor) householdCensus(ctx context.Context) bonjour.Census {
	ctx, cancel := context.WithTimeout(ctx, bonjourCensusTimeout)
	defer cancel()
	out, err := s.QueryScalar(ctx, s.plan.Env.PostgresDB(), householdCensusSQL)
	if err != nil {
		s.log.Warnf("could not read the household name for the Bonjour advertisement: %v", err)
		return bonjour.Census{}
	}
	return parseCensus(out)
}

// One scalar, not two queries: with exactly one row max(name) IS that row's name, and
// with any other count the name is not used at all.
const householdCensusSQL = `select count(*) || '|' || coalesce(max(name), '') from households where deleted_at is null`

// ── the doctor check ────────────────────────────────────────────────────────────────
//
// `status` can only say what this Mac asked for. Whether the rest of the house can
// actually see it is a different question, and the answer is usually a firewall or the
// Local Network privacy prompt — so it is asked once, when a human runs `doctor`, rather
// than on every poll.

// browseTimeout is how long the browse is given. mDNSResponder answers a local
// registration almost immediately; this is generous, and it is spent only on `doctor`.
const browseTimeout = 3 * time.Second

// browseTool is a var so a test can point the browse at a subprocess that behaves badly
// on purpose. Always the real client in production; nothing outside a test reassigns it.
var browseTool = func() string { return bonjour.Tool() }

// browseBonjour asks what is on the network and returns whatever it heard.
//
// `dns-sd -B` browses forever, so it is asked to stop itself with `-t <seconds>` rather
// than killed on a context deadline. That is not a style choice: its stdout is block-
// buffered when it is a pipe rather than a terminal, so a killed browse exits with
// everything it found still in the buffer and this check would report an empty network
// on a Mac that is advertising perfectly well. The context is still bounded, a couple of
// seconds wider, in case dns-sd ignores its own timeout.
func browseBonjour(ctx context.Context, timeout time.Duration) (string, error) {
	tool := browseTool()
	if tool == "" {
		return "", errNoDNSSD
	}
	seconds := int(timeout / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	budget := timeout + browseSlack
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	out, err := exec.CommandContext(ctx, tool, "-t", strconv.Itoa(seconds), "-B", bonjour.ServiceType, ".").Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		// We had to kill it, so its block-buffered stdout is lost and what came back says
		// nothing about the network. Reporting it as a clean empty result would send the
		// operator off to check a firewall that is not the problem.
		return string(out), fmt.Errorf("the browse did not finish within %s", budget)
	}
	if err != nil && ctx.Err() == nil {
		// It failed for its own reasons rather than because we stopped it.
		return string(out), err
	}
	return string(out), nil
}

// browseSlack is how much longer than its own `-t` deadline dns-sd is given before the
// context kills it — for the case where it ignores that deadline.
const browseSlack = 2 * time.Second

var errNoDNSSD = errors.New("this platform has no dns-sd client")

// instanceSeen reads dns-sd's browse table for one of our own registrations.
//
// The match is the name exactly, or the name followed by " (" — mDNSResponder appends
// " (2)" when another Mac on the network already advertises the same household name, and
// that renamed instance is still ours. A bare prefix match would also swallow a
// neighbour's "Smith Family" for a household called "Smith", and reporting a stranger's
// advertisement as ours turns a blocked registration into a clean bill of health.
func instanceSeen(out, name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		// Timestamp, A/R, Flags, if, Domain, Service Type, then the instance name —
		// which may itself contain spaces, so it is whatever is left.
		if len(fields) < 7 || fields[1] != "Add" {
			continue
		}
		instance := strings.Join(fields[6:], " ")
		if instance == name || strings.HasPrefix(instance, name+" (") {
			return true
		}
	}
	return false
}

// bonjourCheck answers "can a phone find this Mac?".
func (s *Supervisor) bonjourCheck(ctx context.Context) Check {
	const name = "bonjour"
	b := s.BonjourStatus()
	switch {
	case browseTool() == "":
		return Check{Name: name, Status: CheckWarn,
			Detail: "this platform has no dns-sd client, so devices have to be given the address"}
	case b.Error != "":
		return Check{Name: name, Status: CheckWarn, Detail: "not advertising: " + b.Error}
	case !b.Advertised && s.serviceRunning(services.Caddy):
		// The distinction matters: "start the server" is unhelpful advice to someone
		// whose server is plainly running.
		return Check{Name: name, Status: CheckWarn, Detail: fmt.Sprintf(
			"the server is running but nothing is being advertised — see %s",
			s.plan.Layout.LogPath(services.Bonjour))}
	case !b.Advertised:
		return Check{Name: name, Status: CheckWarn,
			Detail: "nothing is being advertised — start the server to make it discoverable"}
	}

	out, err := browseBonjour(ctx, browseTimeout)
	if err != nil {
		return Check{Name: name, Status: CheckWarn, Detail: fmt.Sprintf("could not browse the network: %v", err)}
	}
	if !instanceSeen(out, b.Name) {
		return Check{Name: name, Status: CheckWarn, Detail: fmt.Sprintf(
			"%q is registered but did not answer a browse within %s — check the firewall "+
				"(System Settings → Network → Firewall) and, on Sonoma and later, that Waffled is "+
				"allowed under Privacy & Security → Local Network", b.Name, browseTimeout)}
	}
	return Check{Name: name, Status: CheckOK, Detail: fmt.Sprintf(
		"%q is discoverable as %s on %s port %d", b.Name, bonjour.ServiceType, b.Host, b.Port)}
}

func parseCensus(out string) bonjour.Census {
	// Cut once: a household name may contain the separator, the count never can.
	count, name, ok := strings.Cut(strings.TrimSpace(out), "|")
	if !ok {
		return bonjour.Census{}
	}
	n, err := strconv.Atoi(strings.TrimSpace(count))
	if err != nil || n < 0 {
		return bonjour.Census{}
	}
	return bonjour.Census{Known: true, Count: n, Name: name}
}
