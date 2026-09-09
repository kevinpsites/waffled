// Package supervisor is the part that replaces Compose: it owns the dependency order,
// the health gates, the restart policy and the ordered shutdown that `depends_on`,
// `healthcheck` and `restart: unless-stopped` gave us for free inside Docker.
//
// The start sequence is the spike's, proven end to end in Phase 1:
//
//	postgres → (init databases) → migrate → api → powersync → caddy
//
// Stop walks it backwards. Every step is idempotent, so `start` on an already-running
// stack is a no-op rather than a mess, and a start interrupted halfway repairs itself.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/caddyconf"
	"github.com/kevinpsites/waffled/apps/runtime/internal/configenv"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/manifest"
	"github.com/kevinpsites/waffled/apps/runtime/internal/ports"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/status"
)

// Default ports. The public one matches Compose so a household moving from Docker keeps
// its bookmarks; the loopback ones sit beside the compose defaults for the same reason.
const (
	DefaultPublicPort          = 8080
	DefaultPowerSyncPublicPort = 8081
	DefaultAPIPort             = 3000
	DefaultPowerSyncPort       = 8082
	DefaultPostgresPort        = 5432
	// portScanWindow is how far past a taken default to look before giving up.
	portScanWindow = 100
)

// Health gate timeouts, generous enough for a cold first start on a busy Mac.
const (
	apiHealthTimeout       = 90 * time.Second
	powersyncHealthTimeout = 120 * time.Second
	caddyHealthTimeout     = 30 * time.Second
	migrateTimeout         = 10 * time.Minute
	stopGrace              = 15 * time.Second
)

// SupervisorPidName is the pidfile for the supervisor process itself, which `stop`
// signals and `status` reads.
const SupervisorPidName = "supervisor"

// Options configure a Supervisor.
type Options struct {
	// BundleDir is the runtime bundle. Empty means "derive from the binary's location".
	BundleDir string
	// DataDir is the data directory. Empty means the platform default.
	DataDir string
	// Log receives the supervisor's narration.
	Log *Logger
	// TolerateConflicts turns a port conflict from a construction failure into a
	// recorded fault. `status` and `doctor` set it: a port stolen while the stack was
	// down is the single most likely reason someone runs either command, and refusing
	// to construct would mean `doctor` never reaches its own port check and
	// `status --json` emits no JSON for the menu-bar app to read. `start` leaves it
	// false and still fails hard.
	TolerateConflicts bool
}

// Supervisor owns one data directory and the processes serving it.
type Supervisor struct {
	plan     services.Plan
	log      *Logger
	runner   *runner
	state    *rtstate.State
	manifest *manifest.Manifest

	mu        sync.Mutex
	children  map[string]*child
	lastError string

	// The Bonjour advertiser's own lifecycle (see bonjour.go). bonjourStop ends the
	// refresh goroutine, bonjourOnce makes closing it idempotent — Stop is called twice
	// on a failed start — and bonjourWait is what Stop waits on before killing dns-sd.
	bonjourStop chan struct{}
	bonjourOnce sync.Once
	bonjourWait sync.WaitGroup
	// bonjourMu serialises the read-modify-write of bonjour.json, which the refresh poll
	// and the advertiser's restart supervisor both touch.
	bonjourMu sync.Mutex
	// bonjourMissingOnce keeps "bonjour.json has gone missing" to a single log line. It
	// is one condition, not one per exit, and a flapping advertiser would otherwise
	// report it on every death right up to the cap.
	bonjourMissingOnce sync.Once

	// startedVersion is the Waffled version runtime.json recorded when this Supervisor
	// was constructed — the build that last had this data open, before we touched it.
	//
	// It is kept in memory because New() must not write the running version over it:
	// that value is the "from" half of a pre-migrate snapshot's name and of the
	// downgrade guard's message, and both are asked while the new bundle is already
	// running. The file is only caught up once a start has gone green (see
	// recordBundleVersion), so a start that never finished leaves the record of what
	// wrote the data intact. Empty on data written before the field existed.
	startedVersion string

	// waitHealthy gates a service on its health URL. It is a field, always set to
	// waitHTTP in production, purely so the rollback test can make the api's gate fail
	// for real without a branch in this path that a user could trip. An env variable or
	// a "pretend to fail" flag would be a test hook shipped to households; swapping the
	// prober leaves every line of the production sequence running exactly as it does on
	// a real machine.
	waitHealthy func(ctx context.Context, url string, timeout time.Duration, alive func() error) error
}

// New prepares a Supervisor: it resolves the bundle and data directory, verifies the
// bundle against its manifest, loads or creates config.env, and settles the ports.
// Nothing is started.
func New(opts Options) (*Supervisor, error) {
	bundleDir, err := resolveBundle(opts.BundleDir)
	if err != nil {
		return nil, err
	}
	root := opts.DataDir
	if root == "" {
		root, err = datadir.DefaultRoot()
		if err != nil {
			return nil, err
		}
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	layout := datadir.At(root)
	log := opts.Log
	if log == nil {
		log = NewLogger(os.Stderr, false)
	}

	if err := layout.Ensure(); err != nil {
		return nil, err
	}

	// Nothing in the bundle is executed until it matches the manifest it was built and
	// signed with. The result is memoized per build, so only a new install pays the walk.
	m, cached, err := manifest.VerifyCached(bundleDir, layout.BundleCache)
	if err != nil {
		return nil, err
	}
	if cached {
		log.Infof("bundle verified (cached) — %s", m.VersionSummary())
	} else {
		log.Infof("bundle verified — %d files + %d symlinks — %s", m.FileCount, m.SymlinkCount, m.VersionSummary())
	}

	env, err := configenv.Load(layout.ConfigEnv)
	if err != nil {
		return nil, err
	}
	generated, err := env.EnsureSecrets()
	if err != nil {
		return nil, err
	}
	if len(generated) > 0 {
		log.Infof("generated %d secret(s) in %s", len(generated), layout.ConfigEnv)
	}
	if err := env.Save(layout.ConfigEnv); err != nil {
		return nil, err
	}
	if err := env.Validate(); err != nil {
		return nil, err
	}

	st, existed, err := rtstate.Load(layout.RuntimeJSON)
	if err != nil {
		return nil, err
	}
	if !existed {
		st, err = rtstate.New()
		if err != nil {
			return nil, err
		}
	}

	s := &Supervisor{
		log:            log,
		manifest:       m,
		state:          st,
		startedVersion: st.BundleVersion,
		children:       map[string]*child{},
		runner:         &runner{logsDir: layout.Logs, pidsDir: layout.Pids, log: log},
		waitHealthy:    waitHTTP,
	}
	s.plan = services.Plan{
		Bundle:   bundleDir,
		Layout:   layout,
		Env:      env,
		Manifest: m,
		Ports:    st.Ports,
	}

	if err := s.settlePorts(!existed); err != nil {
		if !opts.TolerateConflicts {
			return nil, err
		}
		// Record it and carry on, so `doctor` can reach the check that explains it and
		// `status --json` still produces a document saying what is wrong.
		s.lastError = err.Error()
		log.Warnf("%v", err)
	}

	socketDir, fellBack, err := layout.SocketDir(st.SocketDir)
	if err != nil {
		return nil, err
	}
	if fellBack && st.SocketDir == "" {
		log.Warnf("the data directory path is too long for a unix socket; "+
			"postgres will use %s for its socket instead", socketDir)
	}
	s.plan.SocketDir = socketDir
	s.state.SocketDir = socketDir
	s.state.BundleSHA = m.GitSha
	s.state.BundleTime = m.BuiltAt
	s.excludeDataFromTimeMachine()

	if err := rtstate.Save(layout.RuntimeJSON, s.state); err != nil {
		return nil, err
	}
	return s, nil
}

// Plan exposes the resolved configuration, for `doctor` and tests.
func (s *Supervisor) Plan() services.Plan { return s.plan }

// Manifest is the verified bundle manifest.
func (s *Supervisor) Manifest() *manifest.Manifest { return s.manifest }

// settlePorts chooses ports on a first run and validates them on later ones.
//
// The asymmetry is the point. On a first run a taken default is fine — take the next
// free port. On later runs a port we already published is a hard error: every phone,
// tablet and bookmark in the household points at it, so silently moving would look like
// the server had vanished.
func (s *Supervisor) settlePorts(firstRun bool) error {
	if s.state.Ports.Public == 0 {
		firstRun = true
	}
	if firstRun {
		chosen, err := choosePorts(ports.IsFree)
		if err != nil {
			return err
		}
		s.state.Ports = chosen
		s.plan.Ports = chosen
		s.log.Infof("chose ports: public %d, sync %d, api %d, powersync %d, postgres %d",
			chosen.Public, chosen.PowerSyncPublic, chosen.API, chosen.PowerSync, chosen.Postgres)
		return nil
	}

	s.plan.Ports = s.state.Ports
	// A port one of our own live services already holds is fine — `start` is idempotent.
	for _, c := range s.plan.PortChecks() {
		if c.Port == 0 {
			return fmt.Errorf("%s has no port recorded in %s — the file is incomplete; "+
				"stop the runtime and remove it to re-pick ports", c.Service, s.plan.Layout.RuntimeJSON)
		}
		if s.ownsPort(c.Service) {
			continue
		}
		if err := ports.VerifyAvailable(c.Scope, c.Port); err != nil {
			return fmt.Errorf("%s cannot start: %w.\nThis install has used that port since it was set up, "+
				"and other devices point at it. Stop whatever took it, or edit %s to choose another",
				c.Service, err, s.plan.Layout.RuntimeJSON)
		}
	}
	return nil
}

// ownsPort answers "is that port held by our own copy of this service?" — the one
// question both settlePorts and doctor ask about every row of the port table. Postgres
// is the exception: it has no pidfile of ours, so its liveness comes from postmaster.pid.
func (s *Supervisor) ownsPort(service string) bool {
	if service == services.Postgres {
		_, ok := s.postgresPid()
		return ok
	}
	return s.serviceRunning(service)
}

// serviceRunning answers from the pidfile, so it is true for a stack started by a
// previous invocation of this binary.
func (s *Supervisor) serviceRunning(name string) bool {
	s.mu.Lock()
	c, ok := s.children[name]
	s.mu.Unlock()
	if ok {
		return c.running()
	}
	pid, err := readPidfile(s.runner.pidPath(name))
	if err != nil {
		return false
	}
	return processAlive(pid)
}

// Start brings the whole stack up in dependency order, gating on health at each step.
func (s *Supervisor) Start(ctx context.Context) error {
	started := time.Now()

	if err := s.initPostgres(ctx); err != nil {
		return s.fail(err)
	}
	if err := s.reconcilePostgresConf(); err != nil {
		return s.fail(err)
	}
	if err := s.startPostgres(ctx); err != nil {
		return s.fail(err)
	}
	if err := s.initDatabases(ctx); err != nil {
		return s.fail(err)
	}

	// Before anything is changed: may this build open this data at all? A bundle OLDER
	// than the schema is the one direction nothing can undo, and re-installing the
	// previous version is the first thing anyone does when an update goes wrong. Here,
	// with Postgres up and migrate not yet run, is the only moment the question can be
	// asked while the answer still costs nothing (see checkNotDowngraded).
	if err := s.checkNotDowngraded(ctx); err != nil {
		return s.fail(err)
	}

	// Plan §5: "Rollback means restore, not reverse migrations." Migrations only run
	// forward, so the way back from a schema change that breaks the api is a dump taken
	// immediately before it. Nothing happens here unless migrations are genuinely
	// pending, which makes a warm start pay one cheap query and nothing else.
	snapshot, err := s.snapshotBeforeMigrate(ctx)
	if err != nil {
		return s.fail(err)
	}

	// The one-shot migrate container, reimplemented. Idempotent, so it runs every start;
	// on a warm start every migration is already applied and it is a fast no-op.
	s.log.Infof("applying database migrations")
	migrateOut, migrateErr := s.runOneShot(ctx, s.plan.Migrate(), migrateTimeout)
	// Keep the output whether or not it succeeded: a migration failure is the single
	// most useful thing in a support conversation, and `logs migrate` must find it.
	if err := appendLog(s.plan.Layout.LogPath(services.Migrate), migrateOut); err != nil {
		s.log.Warnf("could not record the migrate output: %v", err)
	}
	if migrateErr != nil {
		return s.fail(fmt.Errorf("migrations failed: %w\n%s\nsee %s",
			migrateErr, tail(migrateOut, 30), s.plan.Layout.LogPath(services.Migrate)))
	}

	// The api's health gate is what decides whether the migration that just ran was
	// survivable. A failure here with a snapshot in hand is the one case that undoes
	// itself: restore the pre-migration database and refuse to come up, rather than
	// leaving a household with a schema their build cannot serve.
	if err := s.startChild(ctx, s.plan.API(), apiHealthTimeout); err != nil {
		if snapshot == "" {
			return s.fail(err)
		}
		if rbErr := s.rollbackTo(ctx, snapshot); rbErr != nil {
			return s.fail(fmt.Errorf("the api did not start after migrating, AND the database "+
				"could not be rolled back: %v\nThe pre-migration snapshot is intact at %s — "+
				"restore it by hand with `waffled-runtime restore %s`.\nThe original failure was: %w",
				rbErr, snapshot, snapshot, err))
		}
		return s.fail(fmt.Errorf("the api did not start after migrating, so the database was "+
			"rolled back to the snapshot taken beforehand (%s) and the server has not been "+
			"started.\nRe-install the previous version of Waffled, or report this.\n"+
			"The failure was: %w", snapshot, err))
	}
	if err := s.stagePowerSyncConfig(); err != nil {
		return s.fail(err)
	}
	if err := s.startChild(ctx, s.plan.PowerSync(), powersyncHealthTimeout); err != nil {
		return s.fail(err)
	}
	if err := s.writeCaddyfile(); err != nil {
		return s.fail(err)
	}
	if err := s.startChild(ctx, s.plan.Caddy(), caddyHealthTimeout); err != nil {
		return s.fail(err)
	}

	s.mu.Lock()
	s.lastError = ""
	s.mu.Unlock()

	// Only now: the data has been migrated and served by this build, so this build is
	// what a future start should call the version that wrote it.
	s.recordBundleVersion()

	// Last, and only once the server actually answers: an advertisement is a promise
	// that something is there to reach. It cannot fail the start (see bonjour.go).
	s.startBonjour(ctx)

	s.log.Infof("green in %s → %s", time.Since(started).Round(100*time.Millisecond), s.LocalURL())
	if lan := s.LANURL(); lan != "" && lan != s.LocalURL() {
		s.log.Infof("other devices on your network: %s", lan)
	}
	return nil
}

// bundleVersion is the version of the build we are running, or "" when the manifest does
// not name one. One reader, so the fallback to "unknown" is left to whoever formats it.
func (s *Supervisor) bundleVersion() string {
	if s.manifest == nil {
		return ""
	}
	return s.manifest.WaffledVersion
}

// recordBundleVersion catches runtime.json up with the build that just went green, and
// writes down the crossing if there was one.
//
// Deliberately at the END of a successful start, and deliberately best-effort. A start
// that failed leaves the previous version recorded, because that IS still the last build
// this data was served by — and a runtime.json we could not rewrite must not turn a
// working server into a failed start over bookkeeping.
func (s *Supervisor) recordBundleVersion() {
	version := s.bundleVersion()
	if version == "" || s.state == nil {
		return
	}
	if previous := s.state.BundleVersion; previous != version {
		if previous != "" {
			// Only a real crossing is announced. A first start has nothing to compare
			// against, and calling that an update would have the menu bar greet every
			// new install with "Updated to 0.15.0".
			s.state.PreviousBundleVersion = previous
			s.state.BundleVersionChangedAt = time.Now().UTC().Format(time.RFC3339)
			s.log.Infof("this data directory was last served by %s; it is now on %s", previous, version)
		}
		s.state.BundleVersion = version
		if err := rtstate.Save(s.plan.Layout.RuntimeJSON, s.state); err != nil {
			s.log.Warnf("could not record the running version in %s: %v", s.plan.Layout.RuntimeJSON, err)
		}
	}
}

func (s *Supervisor) fail(err error) error {
	s.mu.Lock()
	s.lastError = err.Error()
	s.mu.Unlock()
	return err
}

// startChild launches a supervised service and waits for its health gate. Restart
// supervision is armed only after the service has been healthy once: restarting a
// service that has never worked would just loop over the same misconfiguration.
func (s *Supervisor) startChild(ctx context.Context, spec services.Spec, timeout time.Duration) error {
	if s.serviceRunning(spec.Name) {
		s.mu.Lock()
		_, tracked := s.children[spec.Name]
		s.mu.Unlock()
		if tracked {
			s.log.Infof("%s is already running", spec.Name)
			return nil
		}
		// Running but not ours: a previous supervisor left it behind. Adopt by stopping
		// it, so this process is unambiguously the owner.
		s.log.Warnf("%s was left running by a previous run; restarting it under this supervisor", spec.Name)
		if err := s.stopOrphan(spec.Name); err != nil {
			return err
		}
	}

	s.log.Infof("starting %s", spec.Name)
	c, err := s.runner.start(spec)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.children[spec.Name] = c
	s.mu.Unlock()

	if spec.HealthURL == "" && !spec.OneShot {
		// Nothing to poll — the Bonjour advertiser is the only such child today (api,
		// PowerSync and Caddy all have a health URL, and one-shots never come through
		// here). Claiming it is "healthy" would be a health check nobody ran, but exec
		// returning is not a start either: a dns-sd that mDNSResponder refuses is gone
		// before this line, and reporting success handed the caller a service that was
		// already dead and about to flap.
		if reason, exited := c.exitedWithin(quickExitWindow); exited {
			return fmt.Errorf("%s did not stay running: %s\nsee %s",
				spec.Name, reason, s.plan.Layout.LogPath(spec.Name))
		}
		s.supervise(c, spec)
		s.log.Infof("%s started (pid %d)", spec.Name, c.currentPid())
		return nil
	}
	if err := s.waitHealthy(ctx, spec.HealthURL, timeout, c.liveness()); err != nil {
		return fmt.Errorf("%s did not become healthy: %w\nsee %s",
			spec.Name, err, s.plan.Layout.LogPath(spec.Name))
	}
	s.supervise(c, spec)
	s.log.Infof("%s healthy (pid %d)", spec.Name, c.currentPid())
	return nil
}

// stopOrphan terminates a service left behind by an earlier supervisor process.
func (s *Supervisor) stopOrphan(name string) error {
	pid, err := readPidfile(s.runner.pidPath(name))
	if err != nil {
		return nil
	}
	if !processAlive(pid) {
		_ = os.Remove(s.runner.pidPath(name))
		return nil
	}
	_ = signalPid(pid, syscall.SIGTERM)
	deadline := time.Now().Add(stopGrace)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			_ = os.Remove(s.runner.pidPath(name))
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = signalPid(pid, syscall.SIGKILL)
	time.Sleep(500 * time.Millisecond)
	_ = os.Remove(s.runner.pidPath(name))
	if processAlive(pid) {
		return fmt.Errorf("an old %s process (pid %d) will not exit", name, pid)
	}
	return nil
}

// stagePowerSyncConfig copies service.yaml and sync-config.yaml out of the read-only
// bundle into the data directory. Both are needed: service.yaml references
// sync-config.yaml by a relative path.
func (s *Supervisor) stagePowerSyncConfig() error {
	src := filepath.Join(s.plan.Bundle, "config", "powersync")
	for _, name := range []string{"service.yaml", "sync-config.yaml"} {
		raw, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			return fmt.Errorf("read the bundled powersync config: %w", err)
		}
		if err := os.WriteFile(filepath.Join(s.plan.Layout.PowerSync, name), raw, 0o600); err != nil {
			return fmt.Errorf("stage %s: %w", name, err)
		}
	}
	return nil
}

// writeCaddyfile renders the bundle's compose Caddyfile for this machine.
func (s *Supervisor) writeCaddyfile() error {
	raw, err := os.ReadFile(filepath.Join(s.plan.Bundle, "config", "Caddyfile"))
	if err != nil {
		return fmt.Errorf("read the bundled Caddyfile: %w", err)
	}
	out, err := caddyconf.Render(string(raw), caddyconf.Config{
		APIPort:       s.plan.Ports.API,
		PowerSyncPort: s.plan.Ports.PowerSync,
		WebRoot:       filepath.Join(s.plan.Bundle, "web"),
		MediaRoot:     s.plan.Layout.Media,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.plan.Layout.CaddyfilePath, []byte(out), 0o600); err != nil {
		return fmt.Errorf("write the generated Caddyfile: %w", err)
	}
	return nil
}

// Stop shuts everything down in reverse dependency order.
func (s *Supervisor) Stop(ctx context.Context) error {
	var firstErr error
	note := func(err error) {
		if err != nil {
			s.log.Errorf("%v", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}

	// The advertisement goes first: it is a promise that something is there to reach,
	// and it must not outlive the server by even the length of a shutdown. It is an
	// advisory child and not a member of Children(), so it is stopped by name here.
	s.stopBonjour()

	// Dependency order, backwards: Caddy stops answering before the api it fronts does.
	children := s.plan.Children()
	for i := len(children) - 1; i >= 0; i-- {
		name := children[i].Name
		s.mu.Lock()
		c := s.children[name]
		s.mu.Unlock()
		if c != nil {
			s.log.Infof("stopping %s", name)
			note(c.stop(stopGrace))
			continue
		}
		if s.serviceRunning(name) {
			s.log.Infof("stopping %s (started by a previous run)", name)
			note(s.stopOrphan(name))
		}
	}
	note(s.stopPostgres(ctx))
	return firstErr
}

// Status reports what is actually true right now: pids from pidfiles (so it works across
// process boundaries), health from live probes.
func (s *Supervisor) Status(ctx context.Context) *status.Report {
	r := &status.Report{
		DataDir:   s.plan.Layout.Root,
		BundleDir: s.plan.Bundle,
		Ports: status.Ports{
			Public: s.plan.Ports.Public, PowerSyncPublic: s.plan.Ports.PowerSyncPublic,
			API: s.plan.Ports.API, PowerSync: s.plan.Ports.PowerSync, Postgres: s.plan.Ports.Postgres,
		},
		URLs: status.URLs{Local: s.LocalURL(), LAN: s.LANURL(), PowerSync: s.powerSyncURL()},
	}
	if m := s.manifest; m != nil {
		c := m.Components
		r.Versions = status.Versions{
			Waffled: m.WaffledVersion, Node: c.Node.Version, Postgres: c.Postgres.Version,
			Caddy: c.Caddy.Version, PowerSync: c.PowerSync.Version, API: c.API.Version, Web: c.Web.Version,
		}
		r.Bundle = status.Bundle{
			GitSha: m.GitSha, BuiltAt: m.BuiltAt, Arch: m.Arch, Platform: m.Platform,
			Version: m.WaffledVersion,
			// Constant by construction, not a live signal: New() returns an error on
			// every path where verification failed, so a *Supervisor whose bundle did
			// not verify cannot exist to be asked. The field stays in the JSON because
			// the menu-bar app reads it and the schema is additive.
			Verified: true,
		}
	}
	// From runtime.json, not from this process: `status` is its own command, so the only
	// place "what was this before?" can come from is the file the start wrote it to.
	if s.state != nil {
		r.Bundle.PreviousVersion = s.state.PreviousBundleVersion
		r.Bundle.VersionChangedAt = s.state.BundleVersionChangedAt
	}
	if pid, err := readPidfile(s.runner.pidPath(SupervisorPidName)); err == nil {
		r.Supervisor = status.Supervisor{PID: pid, Running: processAlive(pid)}
	}

	// Postgres: pid from postmaster.pid, health from pg_isready.
	pgSvc := status.Service{
		Name: services.Postgres, Port: s.plan.Ports.Postgres,
		State: status.StateStopped, Log: s.plan.Layout.LogPath(services.Postgres),
	}
	if pid, ok := s.postgresPid(); ok {
		pgSvc.PID = pid
		pgSvc.State = status.StateStarting
		if _, err := s.runOneShot(ctx, s.plan.PgIsReady(), 5*time.Second); err == nil {
			pgSvc.State = status.StateRunning
			pgSvc.Health = "ok"
		} else {
			pgSvc.State = status.StateUnhealthy
			pgSvc.Health = "not accepting connections"
		}
	}
	r.Services = append(r.Services, pgSvc)

	for _, spec := range s.plan.Children() {
		r.Services = append(r.Services, s.serviceStatus(ctx, spec))
	}

	r.Backups = backup.Describe(s.plan.Layout.Backups, s.scheduleInstalled())
	// Reported beside the services, never as one of them: nothing about the
	// advertisement feeds DeriveState (see bonjour.go).
	r.Bonjour = s.BonjourStatus()

	s.mu.Lock()
	r.LastError = s.lastError
	s.mu.Unlock()
	r.Stamp()
	return r
}

func (s *Supervisor) serviceStatus(ctx context.Context, spec services.Spec) status.Service {
	svc := status.Service{
		Name: spec.Name, State: status.StateStopped,
		Port: spec.Port,
		Log:  s.plan.Layout.LogPath(spec.Name),
	}

	s.mu.Lock()
	c := s.children[spec.Name]
	s.mu.Unlock()
	if c != nil {
		svc.PID = c.currentPid()
		svc.Restarts = c.restarts()
		svc.LastError = c.lastError()
		if !c.running() {
			svc.State = status.StateUnhealthy
			svc.PID = 0
			return svc
		}
	} else if pid, err := readPidfile(s.runner.pidPath(spec.Name)); err == nil && processAlive(pid) {
		svc.PID = pid
	} else {
		return svc
	}

	svc.State = status.StateStarting
	if spec.HealthURL == "" || httpOK(ctx, spec.HealthURL) {
		svc.State = status.StateRunning
		svc.Health = "ok"
	} else {
		svc.Health = "health check failing"
		svc.State = status.StateUnhealthy
	}
	return svc
}

// LocalURL is the address that works on this Mac.
func (s *Supervisor) LocalURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", s.plan.Ports.Public)
}

// LANURL is the address to give a phone or the kiosk tablet. Empty when this Mac has no
// routable address — the menu should then say "not on a network" rather than show
// localhost, which only ever works here.
func (s *Supervisor) LANURL() string {
	ip := lanIP()
	if ip == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", ip, s.plan.Ports.Public)
}

func (s *Supervisor) powerSyncURL() string {
	if ip := lanIP(); ip != "" {
		return fmt.Sprintf("http://%s:%d", ip, s.plan.Ports.PowerSyncPublic)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", s.plan.Ports.PowerSyncPublic)
}

// lanIP finds this Mac's address on the local network by asking the routing table which
// source address it would use — no packet is sent, and it works without resolving the
// hostname (which on a Mac often answers with something unhelpful).
func lanIP() string {
	conn, err := net.Dial("udp", "192.0.2.1:9") // TEST-NET-1: routable-looking, never routed
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsLoopback() {
		return ""
	}
	return addr.IP.String()
}

// resolveBundle finds the runtime bundle. The default is the binary's parent directory:
// the binary ships at runtime/bin/waffled-runtime inside Waffled.app, so `../` is the
// bundle root.
func resolveBundle(explicit string) (string, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", err
		}
		if err := checkBundle(abs); err != nil {
			return "", err
		}
		return abs, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate this binary: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	candidate := filepath.Dir(filepath.Dir(exe)) // <bundle>/bin/waffled-runtime → <bundle>
	if err := checkBundle(candidate); err != nil {
		return "", fmt.Errorf("%w\nPass --bundle to point at the runtime bundle explicitly", err)
	}
	return candidate, nil
}

func checkBundle(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, manifest.FileName)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s does not look like a runtime bundle (no %s)", dir, manifest.FileName)
		}
		return err
	}
	return nil
}

// appendLog records a one-shot command's output under a run header, creating the file
// if needed so `logs <svc>` always resolves.
func appendLog(path, body string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	header := fmt.Sprintf("── %s ──\n", time.Now().Format(time.RFC3339))
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	_, err = f.WriteString(header + body)
	return err
}
