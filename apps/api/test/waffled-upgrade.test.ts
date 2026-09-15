import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'waffled')
const cliSource = readFileSync(cli, 'utf8')

function runShell(script: string): string {
  return execFileSync('bash', ['-c', `
    source "$1" help >/dev/null
    ${script}
  `, '_', cli], { encoding: 'utf8' })
}

describe('waffled upgrade safety', () => {
  it('rejects unknown flags before running preflight work', () => {
    const result = spawnSync('bash', [cli, 'upgrade', '--unknown'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('usage: ./waffled upgrade [--version X.Y.Z] [--skip-backup]')
    expect(result.stdout).not.toContain("Docker isn't installed")
  })

  it('backs up before changing the version pin', () => {
    const upgradeCase = cliSource.slice(cliSource.indexOf('  upgrade)'), cliSource.indexOf('  down)'))

    expect(upgradeCase.indexOf('run_pre_upgrade_backup')).toBeGreaterThan(-1)
    expect(upgradeCase.indexOf('run_pre_upgrade_backup')).toBeLessThan(upgradeCase.indexOf('set_env_var WAFFLED_VERSION'))
  })

  it('rejects a malformed --version before running preflight work', () => {
    for (const args of [['--version', 'banana'], ['--version'], ['--version=1.2']]) {
      const result = spawnSync('bash', [cli, 'upgrade', ...args], { encoding: 'utf8' })

      expect(result.status).toBe(1)
      expect(result.stdout).toContain('usage: ./waffled upgrade [--version X.Y.Z] [--skip-backup]')
      expect(result.stdout).not.toContain("Docker isn't installed")
    }
  })

  it('targets the newest published GitHub release of UPDATE_CHECK_REPO', () => {
    const result = runShell(`
      ENV_FILE="$(mktemp)"
      printf 'UPDATE_CHECK_REPO=acme/waffled\\n' > "$ENV_FILE"
      curl() {
        for a in "$@"; do last="$a"; done
        printf 'url=%s\\n' "$last" >&2
        printf '{\\n  "url": "x",\\n  "tag_name": "v0.16.0",\\n  "name": "Waffled v0.16.0"\\n}\\n'
      }
      set +e
      version="$(latest_release_version 2>"$ENV_FILE.err")"
      printf 'exit=%s version=%s\\n' "$?" "$version"
      cat "$ENV_FILE.err"
    `)

    expect(result).toContain('exit=0 version=0.16.0')
    expect(result).toContain('url=https://api.github.com/repos/acme/waffled/releases/latest')
  })

  it('stops with a --version hint when the latest release cannot be looked up', () => {
    const result = runShell(`
      ENV_FILE="$(mktemp)"
      curl() { return 22; }
      set +e
      output="$(latest_release_version 2>&1)"
      printf 'exit=%s\\n%s' "$?" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain('kevinpsites/waffled')
    expect(result).toContain('--version X.Y.Z')
  })

  it('refuses to move WAFFLED_VERSION backwards', () => {
    const result = runShell(`
      set +e
      for pair in "0.15.0 0.15.1" "0.15.1 0.15.1" "0.16.0 0.15.1" "0.16.0 latest" "0.16.0 "; do
        set -- $pair
        check_upgrade_target "$1" "\${2:-}" >/dev/null 2>&1
        printf '%s<-%s=%s\\n' "$1" "\${2:-unset}" "$?"
      done
      check_upgrade_target 0.15.0 0.15.1 2>&1 || true
    `)

    expect(result).toContain('0.15.0<-0.15.1=1')
    expect(result).toContain('0.15.1<-0.15.1=0')
    expect(result).toContain('0.16.0<-0.15.1=0')
    expect(result).toContain('0.16.0<-latest=0')
    expect(result).toContain('0.16.0<-unset=0')
    expect(result).toContain('forward-only')
  })

  // A pin that isn't a plain version can't be compared, and the caller re-pins to whatever
  // it was handed — so the operator has to hear that the direction went unchecked.
  it('says when a pin gives it nothing to compare against', () => {
    const result = runShell(`
      set +e
      check_upgrade_target 0.14.0 latest 2>&1
      check_upgrade_target 0.14.0 "" 2>&1
    `)

    expect(result.match(/can't tell whether 0\.14\.0 moves forward/g)).toHaveLength(2)
    expect(result).toContain('WAFFLED_VERSION is latest')
    expect(result).toContain('WAFFLED_VERSION is unset')
  })

  describe('moving the checkout to the release tag', () => {
    // Stubs `git -C "$ROOT" …`; each scenario sets the repository shape through env vars.
    const gitStub = `
      calls="$(mktemp)"
      git() {
        shift 2
        printf '%s\\n' "$*" >> "$calls"
        case "$*" in
          "rev-parse --git-dir") return \${IS_REPO:-0} ;;
          "fetch --quiet origin tag v0.16.0") return \${FETCH_EXIT:-0} ;;
          "rev-parse HEAD") printf '%s\\n' "\${HEAD_SHA:-aaa}" ;;
          "rev-parse v0.16.0^{commit}") printf '%s\\n' "\${TAG_SHA:-bbb}" ;;
          "merge-base --is-ancestor v0.16.0 HEAD") return \${TAG_IN_HEAD:-1} ;;
          "merge-base --is-ancestor HEAD v0.16.0") return \${HEAD_IN_TAG:-0} ;;
          "symbolic-ref --short -q HEAD") [ -n "\${BRANCH-main}" ] || return 1; printf '%s\\n' "\${BRANCH-main}" ;;
          "merge --ff-only --quiet v0.16.0") return \${MOVE_EXIT:-0} ;;
          "checkout --quiet v0.16.0") return \${MOVE_EXIT:-0} ;;
          *) return 97 ;;
        esac
      }
      set +e
    `
    const run = (env: string) => runShell(`
      ${gitStub}
      ${env}
      output="$(update_repo_for_upgrade 0.16.0 2>&1)"
      code=$?
      printf 'exit=%s\\n%s\\n--calls--\\n' "$code" "$output"
      cat "$calls"
    `)

    it('fast-forwards a branch to the tag instead of pulling main', () => {
      const result = run('')

      expect(result).toContain('exit=0')
      expect(result).toContain('merge --ff-only --quiet v0.16.0')
      expect(result).not.toMatch(/\bpull\b/)
    })

    it('checks the tag out on a detached HEAD', () => {
      const result = run('BRANCH=""')

      expect(result).toContain('exit=0')
      expect(result).toContain('checkout --quiet v0.16.0')
    })

    it('leaves a checkout that is already at the tag alone', () => {
      const result = run('HEAD_SHA=bbb TAG_IN_HEAD=0')

      expect(result).toContain('exit=0')
      expect(result).not.toContain('merge --ff-only')
      expect(result).not.toContain('checkout --quiet')
    })

    // Warning and carrying on would re-pin WAFFLED_VERSION to the older release and pull
    // its images under a newer compose file and ./waffled — the pairing this whole command
    // exists to prevent. Stopping leaves the running stack untouched.
    it('stops when the checkout is ahead of the release', () => {
      const result = run('TAG_IN_HEAD=0 HEAD_IN_TAG=1')

      expect(result).toContain('exit=1')
      expect(result).toContain('ahead of v0.16.0')
      expect(result).toContain('No images were changed')
      expect(result).not.toContain('merge --ff-only')
    })

    it('aborts before any image change when the tag cannot be fetched', () => {
      const result = run('FETCH_EXIT=1')

      expect(result).toContain('exit=1')
      expect(result).toContain("Couldn't fetch v0.16.0")
      expect(result).toContain('No images were changed')
    })

    it('aborts when the checkout has diverged from the release', () => {
      const result = run('HEAD_IN_TAG=1')

      expect(result).toContain('exit=1')
      expect(result).toContain('No images were changed')
      expect(result).not.toContain('merge --ff-only')
    })

    it('aborts when local changes block the move', () => {
      const result = run('MOVE_EXIT=1')

      expect(result).toContain('exit=1')
      expect(result).toContain('No images were changed')
    })

    it('skips the repository step outside a git checkout', () => {
      const result = run('IS_REPO=1')

      expect(result).toContain('exit=0')
      expect(result).not.toContain('fetch')
    })
  })

  it('pins the resolved release, not the checkout .env.example, and re-execs with it', () => {
    const upgradeCase = cliSource.slice(cliSource.indexOf('  upgrade)'), cliSource.indexOf('  down)'))

    expect(upgradeCase).not.toContain('.env.example')
    expect(upgradeCase).toContain('update_repo_for_upgrade "$target"')
    expect(upgradeCase).toContain('reexec_args=(--version "$target")')
    expect(upgradeCase).toMatch(/maybe_reexec_upgrade "\$script_before" \$\{reexec_args\[@\]\+"\$\{reexec_args\[@\]\}"\}/)
    expect(upgradeCase.indexOf('check_upgrade_target')).toBeLessThan(upgradeCase.indexOf('update_repo_for_upgrade'))
  })

  it('aborts when the backup service is unavailable', () => {
    const result = runShell(`
      docker() { return 0; }
      grep() { return 1; }
      set +e
      output="$(run_pre_upgrade_backup 0 2>&1)"
      code=$?
      printf 'exit=%s\n%s' "$code" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain('backup service is not running')
    expect(result).toContain('--skip-backup')
  })

  it('aborts when the pre-upgrade backup command fails', () => {
    const result = runShell(`
      docker() {
        case "$1" in
          ps) printf 'waffled-backup\n'; return 0 ;;
          exec) return 1 ;;
        esac
      }
      set +e
      output="$(run_pre_upgrade_backup 0 2>&1)"
      code=$?
      printf 'exit=%s\n%s' "$code" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain('backup failed')
    expect(result).toContain('upgrade has been stopped')
  })

  // `--override` is stripped from "$@" at parse time, so the handoff to a freshly pulled
  // ./waffled must pass it back or the restarted upgrade drops the override compose file.
  it('re-execs a changed script with every compose override and the upgrade args', () => {
    const result = runShell(`
      tmp="$(mktemp -d)"
      printf 'old script body\\n' > "$tmp/waffled"
      ROOT="$tmp"
      before="$(script_checksum)"
      printf '%s\\n' '#!/bin/sh' 'echo "guard=$WAFFLED_UPGRADE_REEXEC"' 'for a in "$@"; do echo "[$a]"; done' 'rm -rf "\${0%/*}"' > "$tmp/waffled"
      chmod +x "$tmp/waffled"
      COMPOSE_OVERRIDES=("infra/compose/docker-compose.oci.yml" "/srv/my overrides/extra.yml")
      maybe_reexec_upgrade "$before" --skip-backup
    `)

    expect(result).toContain('guard=1')
    const argv = result.split('\n').filter((line) => line.startsWith('[')).map((line) => line.slice(1, -1))
    expect(argv[0]).toBe('upgrade')
    expect(argv).toContain('--skip-backup')
    const overrides = argv.flatMap((arg, i) => (arg === '--override' ? [argv[i + 1]] : []))
    expect(overrides).toEqual(['infra/compose/docker-compose.oci.yml', '/srv/my overrides/extra.yml'])
  })

  it('re-execs with only the upgrade args when there are no compose overrides', () => {
    const result = runShell(`
      tmp="$(mktemp -d)"
      printf 'old script body\\n' > "$tmp/waffled"
      ROOT="$tmp"
      before="$(script_checksum)"
      printf '%s\\n' '#!/bin/sh' 'for a in "$@"; do echo "[$a]"; done' 'rm -rf "\${0%/*}"' > "$tmp/waffled"
      chmod +x "$tmp/waffled"
      COMPOSE_OVERRIDES=()
      maybe_reexec_upgrade "$before"
    `)

    expect(result.split('\n').filter((line) => line.startsWith('['))).toEqual(['[upgrade]'])
  })

  it('skips backup work only when explicitly requested', () => {
    const result = runShell(`
      docker() { return 99; }
      run_pre_upgrade_backup 1
      printf 'exit=%s' "$?"
    `)

    expect(result).toContain('--skip-backup was supplied')
    expect(result).toContain('exit=0')
  })
})
