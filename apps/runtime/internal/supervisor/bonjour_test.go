package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/bonjour"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

func TestParseCensusReadsWhatPsqlPrints(t *testing.T) {
	cases := []struct {
		out  string
		want bonjour.Census
	}{
		// count|name, unaligned and untitled — what `psql -tAc` gives back.
		{"1|The Seinfelds\n", bonjour.Census{Known: true, Count: 1, Name: "The Seinfelds"}},
		{"0|\n", bonjour.Census{Known: true, Count: 0}},
		{"3|Costanza\n", bonjour.Census{Known: true, Count: 3, Name: "Costanza"}},
		// A household name may contain the separator; only the first one counts.
		{"1|Jerry|Elaine", bonjour.Census{Known: true, Count: 1, Name: "Jerry|Elaine"}},
		// Anything we cannot read is "unknown", never "no households".
		{"", bonjour.Census{}},
		{"psql: error: connection refused", bonjour.Census{}},
		{"|nonsense", bonjour.Census{}},
	}
	for _, tc := range cases {
		got := parseCensus(tc.out)
		if got != tc.want {
			t.Errorf("parseCensus(%q) = %+v, want %+v", tc.out, got, tc.want)
		}
	}
}

func TestBonjourStateRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if _, ok := readBonjourState(path); ok {
		t.Fatal("read a state file that does not exist")
	}

	want := bonjourState{Name: "Kevin’s Home", Port: 8080, Setup: false, Error: ""}
	if err := writeBonjourState(path, want); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, ok := readBonjourState(path)
	if !ok {
		t.Fatal("the state file just written does not read back")
	}
	if got.Name != want.Name || got.Port != want.Port {
		t.Errorf("round trip lost something: %+v", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// The URL belongs in the TXT record, which is where a client reads it. Recording it
	// here as well gave it a second copy to keep correct on every write and no reader at
	// all: `status` reports urls.lan, and the block has never had a url field.
	if strings.Contains(string(raw), `"url"`) {
		t.Errorf("bonjour.json still records a url nothing reads back:\n%s", raw)
	}
	// Same story for the supervisor's pid, which was written on every update and read by
	// nothing. Its comment promised an ownership check that was never implemented, and a
	// field carrying a claim no code makes good on is worse than no field: the next
	// person to reach for a freshness gate would find one already there and trust it.
	// What is actually on the network is the advertiser's OWN pidfile — see the orphan
	// test below, which is the case a supervisor pid would have been wrong about.
	if strings.Contains(string(raw), "upervisorPid") {
		t.Errorf("bonjour.json still records a supervisor pid nothing reads back:\n%s", raw)
	}
	if got.UpdatedAt == "" {
		t.Error("UpdatedAt is empty — a stale file must be recognisable as old")
	}
	// It sits beside config.env in a directory that is 0700, but the file itself says
	// nothing secret; 0600 is the house style for everything the runtime writes.
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 600", perm)
	}
}

// dns-sd is spawned with Setpgid, so a SIGKILLed supervisor does NOT take it with it:
// the advertisement stays on the network under an adopted process. What is on the
// network is therefore the ADVERTISER's pidfile's answer — and `status` must name what a
// phone can actually see. This is the case that makes a supervisor pid in bonjour.json
// worse than useless: the run that wrote the file is gone, and the advertisement is not.
func TestAnOrphanedAdvertiserIsStillReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if err := writeBonjourState(path, bonjourState{Name: "The Seinfelds", Port: 8080}); err != nil {
		t.Fatal(err)
	}
	got := bonjourStatus(path, true)
	if !got.Advertised {
		t.Error("an advertiser that outlived its supervisor was reported as nothing on the network")
	}
	if got.Name != "The Seinfelds" || got.Port != 8080 {
		t.Errorf("got %+v, want the name and port that are actually being advertised", got)
	}
}

// With the advertiser gone too, the file is only a record of what was asked for: nothing
// is named on the network, but the recorded reason survives — the file exists at all only
// because the last stop was unclean, and that reason is what explains it.
func TestBonjourStateWithNoAdvertiserNamesNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bonjour.json")
	if err := writeBonjourState(path, bonjourState{
		Name: "The Seinfelds", Port: 8080, Error: "boom",
	}); err != nil {
		t.Fatal(err)
	}
	got := bonjourStatus(path, false)
	if got.Advertised || got.Name != "" || got.Port != 0 {
		t.Errorf("a household was named while nothing is advertising: %+v", got)
	}
	if got.Error != "boom" {
		t.Errorf("error = %q, want the recorded reason", got.Error)
	}
	if got.Service != bonjour.ServiceType {
		t.Errorf("service = %q, want the constant %q even when nothing is advertising", got.Service, bonjour.ServiceType)
	}
}

func TestBonjourStatusReportsTheLiveAdvertisement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if err := writeBonjourState(path, bonjourState{Name: "The Seinfelds", Port: 8080}); err != nil {
		t.Fatal(err)
	}

	got := bonjourStatus(path, true)
	if !got.Advertised {
		t.Error("advertised = false while the supervisor is alive and dns-sd is running")
	}
	if got.Name != "The Seinfelds" || got.Port != 8080 {
		t.Errorf("got %+v, want the recorded name and port", got)
	}
	if got.Host == "" {
		t.Error("host is empty — a device needs a name to resolve")
	}

	// dns-sd gone while the supervisor lives: the name is still what we asked for, but
	// nothing is on the network.
	if stopped := bonjourStatus(path, false); stopped.Advertised {
		t.Error("advertised = true with no dns-sd process")
	}
}

func TestBonjourStatusCarriesTheFailureReason(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bonjour.json")
	if err := writeBonjourState(path, bonjourState{
		Error: "dns-sd is not available on this platform",
	}); err != nil {
		t.Fatal(err)
	}
	got := bonjourStatus(path, false)
	if got.Advertised {
		t.Error("advertised = true after a failure")
	}
	if got.Error == "" {
		t.Error("the failure reason was dropped — `status` is where someone looks for it")
	}
}

// The setup→household transition is the one a person watches happen, and the poll that
// notices it used to be armed only when the FIRST census was a positive read of an empty
// install. A first-boot hiccup — a psql too slow to answer, a dns-sd that failed to exec
// — latched the wrong advertisement until the next restart.
//
// The census and the advertise step are parameters so the decision logic can be driven
// through all three of its states without registering anything on the real network.
func TestTheAdvertisementIsRecheckedUntilAHouseholdIsOnTheNetwork(t *testing.T) {
	restore := bonjourSetupPoll
	bonjourSetupPoll = 10 * time.Millisecond
	t.Cleanup(func() { bonjourSetupPoll = restore })

	s := &Supervisor{log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{}}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop); s.bonjourWait.Wait() })

	// Unknown (psql could not be asked), then a positive read of an empty install, then
	// the household the wizard just created.
	censuses := []bonjour.Census{
		{},
		{Known: true, Count: 0},
		{Known: true, Count: 1, Name: "The Seinfelds"},
	}
	var mu sync.Mutex
	asked := 0
	census := func(context.Context) bonjour.Census {
		mu.Lock()
		defer mu.Unlock()
		i := asked
		if i > len(censuses)-1 {
			i = len(censuses) - 1
		}
		asked++
		return censuses[i]
	}
	var got []advertisement
	advertise := func(_ context.Context, c bonjour.Census) advertisement {
		a := plannedAdvertisement(c)
		a.live = true
		mu.Lock()
		got = append(got, a)
		mu.Unlock()
		return a
	}

	s.bonjourRefresh(context.Background(), stop, census, advertise)
	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) >= 3
	}, "the household never reached the network")
	s.bonjourWait.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("%d advertisements, want 3: %+v", len(got), got)
	}
	if got[0].setup || got[0].name == "" {
		t.Errorf("first advertisement = %+v, want the machine fallback with setup=0 "+
			"(an unreadable census must never send someone back to the wizard)", got[0])
	}
	if !got[1].setup {
		t.Errorf("second advertisement = %+v, want setup=1 on a positive read of an empty install", got[1])
	}
	if got[2].name != "The Seinfelds" || got[2].setup {
		t.Errorf("third advertisement = %+v, want the household's own name with setup=0", got[2])
	}
}

// A settled census still has to be re-tried when the registration itself failed: a
// dns-sd that could not exec once must not leave the household undiscoverable forever.
func TestATransientAdvertiseFailureIsRetried(t *testing.T) {
	restore := bonjourSetupPoll
	bonjourSetupPoll = 10 * time.Millisecond
	t.Cleanup(func() { bonjourSetupPoll = restore })

	s := &Supervisor{log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{}}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop); s.bonjourWait.Wait() })

	settled := bonjour.Census{Known: true, Count: 1, Name: "The Seinfelds"}
	census := func(context.Context) bonjour.Census { return settled }
	var mu sync.Mutex
	attempts := 0
	advertise := func(_ context.Context, c bonjour.Census) advertisement {
		a := plannedAdvertisement(c)
		mu.Lock()
		attempts++
		a.live = attempts > 1 // the first exec fails, the next one works
		mu.Unlock()
		return a
	}

	s.bonjourRefresh(context.Background(), stop, census, advertise)
	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return attempts >= 2
	}, "a failed first registration was never retried")
	s.bonjourWait.Wait()

	mu.Lock()
	defer mu.Unlock()
	if attempts != 2 {
		t.Errorf("%d attempts, want 2 — polling must stop once the household is on the network", attempts)
	}
}

// The advertiser has no health URL, so startChild used to report success the moment exec
// returned. A dns-sd that mDNSResponder refuses exits immediately, and the caller was
// handed a "started" service that was already gone — leaving `bonjour.json` with no error
// at all while the restart loop flapped.
func TestAHealthlessChildThatExitsAtOnceIsAStartFailure(t *testing.T) {
	s := &Supervisor{
		log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{},
		plan: services.Plan{Layout: datadir.At(t.TempDir())},
	}
	err := s.startChild(context.Background(), shell(services.Bonjour, "exit 7"), 0)
	if err == nil {
		t.Fatal("a child that exited immediately was reported as started")
	}
	if !strings.Contains(err.Error(), "7") {
		t.Errorf("error = %v, want the exit status the caller has to record", err)
	}
}

// The same window must not turn an ordinary start into a failure.
func TestAHealthlessChildThatStaysUpStartsCleanly(t *testing.T) {
	s := &Supervisor{
		log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{},
		plan: services.Plan{Layout: datadir.At(t.TempDir())},
	}
	spec := shell(services.Bonjour, "exec sleep 30")
	if err := s.startChild(context.Background(), spec, 0); err != nil {
		t.Fatalf("a healthy long-running child was refused: %v", err)
	}
	t.Cleanup(func() { s.stopBonjourChild() })
	if !s.serviceRunning(services.Bonjour) {
		t.Error("the child is not running after a successful start")
	}
}

// Every advertisement used to fork scutil for a computer name a settled install throws
// away: Census.Advertise returns the household's own name and never looks at it. The name
// is now asked for only where the fallback needs it.
func TestASettledInstallNeverForksForTheComputerName(t *testing.T) {
	restore := computerName
	asked := 0
	computerName = func() string {
		asked++
		return "Kevin’s MacBook Pro"
	}
	t.Cleanup(func() { computerName = restore })

	if a := plannedAdvertisement(bonjour.Census{Known: true, Count: 1, Name: "The Seinfelds"}); a.name != "The Seinfelds" {
		t.Fatalf("name = %q, want the household's own", a.name)
	}
	if asked != 0 {
		t.Errorf("scutil was forked %d times for a name the household does not need", asked)
	}
	if a := plannedAdvertisement(bonjour.Census{Known: true, Count: 0}); a.name != "Waffled on Kevin’s MacBook Pro" {
		t.Errorf("name = %q, want the machine fallback", a.name)
	}
	if asked != 1 {
		t.Errorf("the fallback asked %d times, want once", asked)
	}
}

// An exit reason that arrives while bonjour.json is missing used to be dropped on the
// floor: reportBonjourExit read the file, found nothing and returned without writing or
// logging. The file can genuinely be absent — the very first writeBonjour only WARNS on
// failure, and a removed or half-written file reads the same way — and status runs in a
// different process with nothing else to read, so the advertiser would report as "not
// advertising" with an empty reason for the rest of the run. That is precisely the state
// this callback exists to make visible.
func TestAnExitReasonSurvivesAMissingStateFile(t *testing.T) {
	s := &Supervisor{
		log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{},
		plan: services.Plan{Layout: datadir.At(t.TempDir())},
	}
	if _, ok := readBonjourState(s.plan.Layout.BonjourState); ok {
		t.Fatal("a state file exists before anything wrote one")
	}

	s.reportBonjourExit("dns-sd exited with status 1", true)

	st, ok := readBonjourState(s.plan.Layout.BonjourState)
	if !ok {
		t.Fatal("no bonjour.json was written, so the exit reason is unreadable to status")
	}
	if !strings.Contains(st.Error, "status 1") {
		t.Errorf("error = %q, want the reason supervision reported", st.Error)
	}
	// Giving up is the half a person has to act on: nothing retries without them.
	if !strings.Contains(st.Error, "restart the server") {
		t.Errorf("error = %q, want the advice that goes with giving up", st.Error)
	}
}

// A reconstructed record should still name what was being advertised. Once bonjour.json
// is gone, the dying child's own argv is the only place that survives, and a record that
// names the instance is the difference between "something failed" and a line status can
// actually print.
func TestAReconstructedStateNamesWhatWasBeingAdvertised(t *testing.T) {
	s := &Supervisor{
		log: testLogger(t), runner: newTestRunner(t), children: map[string]*child{},
		plan: services.Plan{Layout: datadir.At(t.TempDir())},
	}
	inst := bonjour.Instance{Name: "The Seinfelds", Port: 8080, URL: "http://192.168.1.5:8080", Version: "0.15.0"}
	s.children[services.Bonjour] = &child{spec: services.Spec{
		Name: services.Bonjour, Path: "dns-sd", Args: inst.Args("dns-sd"),
	}}

	s.reportBonjourExit("dns-sd exited with status 1", false)

	st, ok := readBonjourState(s.plan.Layout.BonjourState)
	if !ok {
		t.Fatal("no bonjour.json was written")
	}
	if st.Name != inst.Name || st.Port != inst.Port {
		t.Errorf("recovered %q port %d, want %q port %d", st.Name, st.Port, inst.Name, inst.Port)
	}
	if !strings.Contains(st.Error, "status 1") {
		t.Errorf("error = %q, want the reason supervision reported", st.Error)
	}
}
