// In-container operator CLI for break-glass / recovery without the web UI.
// Runs inside nook-api (where DATABASE_URL + TOKEN_ENCRYPTION_KEY are set), so it
// reaches the DB directly — no HTTP, no admin token. Invoked as
//   ./nook admin <command> [flags]   →   docker exec nook-api node dist/admin.js …
//
// All auth-data writes go through the SAME service helpers the API uses
// (hashPassword / setPersonLogin), so there is one source of truth for hashing and
// the password→identity wiring. Destructive commands require an interactive "y"
// confirmation or the --yes flag.
//
// Commands (see `./nook admin help`):
//   list-members
//   reset-password   --email <e> [--password <pw>] [--yes]
//   make-admin       (--email <e> | --person <uuid>)
//   revoke-admin     (--email <e> | --person <uuid>)
//   password-login   <on|off>
//   clear-calendar-error  (--email <e> | --all) [--yes]
//   prune-sessions   [--email <e>] [--yes]
//   regenerate-powersync-key
//   list-households
//   delete-household --id <uuid> [--force] [--yes]
import { createInterface } from 'node:readline'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { query, getPool, closePool } from '../src/platform/db'
import { hashPassword, setPersonLogin, sha256 } from '../src/modules/auth/auth'

// ── tiny arg parser ───────────────────────────────────────────────────────────
// Read argv live (not a captured copy) so tests can set process.argv per call.
const args = (): string[] => process.argv.slice(2)
function flag(name: string): string | undefined {
  const a = args()
  const i = a.indexOf(`--${name}`)
  return i !== -1 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : undefined
}
function has(name: string): boolean {
  return args().includes(`--${name}`)
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', cyan: '\x1b[36m',
}
const ok = (s: string) => `${c.grn}${s}${c.reset}`
const warn = (s: string) => `${c.ylw}${s}${c.reset}`
const err = (s: string) => `${c.red}${s}${c.reset}`

function die(msg: string, code = 1): never {
  process.stderr.write(err(`✗ ${msg}`) + '\n')
  process.exit(code)
}

// Confirm a destructive action: --yes skips; an interactive TTY prompts; a
// non-interactive call without --yes refuses (so it's safe to script).
async function confirm(question: string): Promise<boolean> {
  if (has('yes')) return true
  if (!process.stdin.isTTY) {
    process.stderr.write(warn(`Refusing without confirmation. Re-run with --yes to proceed.`) + '\n')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((res) => rl.question(`${question} ${c.dim}[y/N]${c.reset} `, res))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// Resolve a credential (and its person/household) from an email — emails are
// globally unique in `credentials`, so this is unambiguous across households.
async function credentialByEmail(email: string) {
  const { rows } = await query<{ id: string; person_id: string; household_id: string; person_name: string }>(
    `select c.id, c.person_id, c.household_id, p.name as person_name
       from credentials c join persons p on p.id = c.person_id
      where lower(c.email) = lower($1) and c.deleted_at is null and p.deleted_at is null
      limit 1`,
    [email]
  )
  return rows[0] ?? null
}

// Resolve a person by --email or --person, scoped to a real household.
async function resolvePerson(): Promise<{ id: string; household_id: string; name: string; is_admin: boolean }> {
  const email = flag('email')
  const personId = flag('person')
  if (email) {
    const cred = await credentialByEmail(email)
    if (!cred) die(`No member found with login email "${email}".`)
    const { rows } = await query<{ is_admin: boolean }>(`select is_admin from persons where id = $1`, [cred.person_id])
    return { id: cred.person_id, household_id: cred.household_id, name: cred.person_name, is_admin: rows[0]?.is_admin ?? false }
  }
  if (personId) {
    const { rows } = await query<{ id: string; household_id: string; name: string; is_admin: boolean }>(
      `select id, household_id, name, is_admin from persons where id = $1 and deleted_at is null`,
      [personId]
    )
    if (!rows[0]) die(`No person found with id "${personId}".`)
    return rows[0]
  }
  die('Provide --email <login email> or --person <uuid>.')
}

// A reasonably strong, type-able random password for the no-password case.
function generatePassword(): string {
  return randomBytes(12).toString('base64url')
}

// ── commands ──────────────────────────────────────────────────────────────────

async function listMembers(): Promise<void> {
  const { rows } = await query<{
    household: string; name: string; member_type: string; is_admin: boolean; is_owner: boolean
    login_email: string | null; has_password: boolean; has_oidc: boolean; person_id: string
  }>(
    `select h.name as household, p.name, p.member_type, p.is_admin,
            (h.owner_person_id = p.id) as is_owner, p.id as person_id,
            (select c.email from credentials c where c.person_id = p.id and c.deleted_at is null limit 1) as login_email,
            exists(select 1 from credentials c where c.person_id = p.id and c.deleted_at is null and c.password_hash is not null) as has_password,
            exists(select 1 from identities i where i.person_id = p.id and i.deleted_at is null and i.provider not in ('password')) as has_oidc
       from persons p join households h on h.id = p.household_id
      where p.deleted_at is null
      order by h.name, p.sort_order, p.created_at`
  )
  if (!rows.length) { console.log(c.dim + 'No members yet — this instance has not been set up.' + c.reset); return }
  let lastHh = ''
  for (const r of rows) {
    if (r.household !== lastHh) { console.log(`\n${c.bold}${r.household}${c.reset}`); lastHh = r.household }
    const badges = [
      r.is_owner ? c.cyan + 'owner' + c.reset : r.is_admin ? c.cyan + 'admin' + c.reset : c.dim + r.member_type + c.reset,
      r.login_email ? r.login_email : c.dim + '(no login)' + c.reset,
      r.has_password ? ok('password') : '',
      r.has_oidc ? ok('sso') : '',
    ].filter(Boolean)
    console.log(`  ${r.name.padEnd(16)} ${badges.join('  ')}  ${c.dim}${r.person_id}${c.reset}`)
  }
  console.log()
}

async function resetPassword(): Promise<void> {
  const email = flag('email')
  if (!email) die('reset-password requires --email <login email>.')
  const cred = await credentialByEmail(email)
  if (!cred) die(`No member found with login email "${email}".`)
  const provided = flag('password')
  if (provided && provided.length < 8) die('Password must be at least 8 characters.')
  const password = provided ?? generatePassword()
  if (!(await confirm(`Reset the password for ${c.bold}${cred.person_name}${c.reset} (${email}) and sign out their active sessions?`))) {
    die('Aborted.', 0)
  }
  // Reuse the API's own helper: hashes with scrypt + ensures a password identity.
  await setPersonLogin(cred.household_id, cred.person_id, email, password)
  // Force re-login everywhere with the new password.
  await query(`update refresh_tokens set revoked_at = now() where person_id = $1 and revoked_at is null`, [cred.person_id])
  console.log(ok(`✓ Password reset for ${cred.person_name} (${email}).`))
  if (!provided) console.log(`  New password: ${c.bold}${password}${c.reset}  ${c.dim}(give this to them; they can change it in Settings)${c.reset}`)
  console.log(c.dim + '  Active sessions were revoked — they must sign in again.' + c.reset)
}

async function makeAdmin(grant: boolean): Promise<void> {
  const p = await resolvePerson()
  if (!grant) {
    const { rows } = await query<{ owner: boolean }>(
      `select (owner_person_id = $1) as owner from households where id = $2`, [p.id, p.household_id]
    )
    if (rows[0]?.owner) die("The household owner is always an admin and can't be demoted.")
  }
  if (p.is_admin === grant) { console.log(c.dim + `${p.name} is already ${grant ? 'an admin' : 'not an admin'} — no change.` + c.reset); return }
  await query(`update persons set is_admin = $1, updated_at = now() where id = $2`, [grant, p.id])
  console.log(ok(`✓ ${p.name} is now ${grant ? 'an admin' : 'a regular member'}.`))
}

async function passwordLogin(): Promise<void> {
  const arg = args()[1]
  if (arg !== 'on' && arg !== 'off') die('Usage: password-login <on|off>')
  const enabled = arg === 'on'
  const { rowCount } = await query(
    `update auth_config set password_login_enabled = $1, updated_at = now() where id = true`, [enabled]
  )
  if (!rowCount) die('No auth_config row found — this instance has not been set up yet.')
  console.log(ok(`✓ Email/password login is now ${enabled ? 'ENABLED' : 'DISABLED'}.`))
  if (!enabled) console.log(warn('  Make sure SSO works first — or you can lock everyone out. Break-glass: set AUTH_FORCE_PASSWORD=1 in the api env and restart.'))
}

async function clearCalendarError(): Promise<void> {
  const email = flag('email')
  if (!email && !has('all')) die('clear-calendar-error requires --email <account email> or --all.')
  let where = 'last_sync_error is not null'
  const params: unknown[] = []
  if (email) { where += ' and lower(email) = lower($1)'; params.push(email) }
  const { rows } = await query<{ id: string; email: string | null; last_sync_error: string | null }>(
    `select id, email, last_sync_error from calendar_accounts where deleted_at is null and ${where}`, params
  )
  if (!rows.length) { console.log(c.dim + 'No calendar accounts currently have a sync error.' + c.reset); return }
  for (const r of rows) console.log(`  ${r.email ?? r.id}: ${c.dim}${(r.last_sync_error ?? '').slice(0, 80)}${c.reset}`)
  if (!(await confirm(`Clear the sync-error flag on ${rows.length} account(s)?`))) die('Aborted.', 0)
  await query(`update calendar_accounts set last_sync_error = null, last_sync_error_at = null where id = any($1)`, [rows.map((r) => r.id)])
  console.log(ok(`✓ Cleared the sync-error flag on ${rows.length} account(s).`))
  console.log(c.dim + '  Note: this only clears the warning. A revoked/expired Google token still needs a' + c.reset)
  console.log(c.dim + '  Reconnect in Settings → Calendars (browser OAuth) to restore syncing.' + c.reset)
}

async function pruneSessions(): Promise<void> {
  const email = flag('email')
  let target = 'all members'
  let where = 'revoked_at is null'
  const params: unknown[] = []
  if (email) {
    const cred = await credentialByEmail(email)
    if (!cred) die(`No member found with login email "${email}".`)
    where += ' and person_id = $1'; params.push(cred.person_id)
    target = `${cred.person_name} (${email})`
  }
  if (!(await confirm(`Revoke ALL active sessions for ${c.bold}${target}${c.reset}? They will have to sign in again.`))) die('Aborted.', 0)
  const { rowCount } = await query(`update refresh_tokens set revoked_at = now() where ${where}`, params)
  console.log(ok(`✓ Revoked ${rowCount ?? 0} active session(s) for ${target}.`))
}

function regeneratePowerSyncKey(): void {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const b64 = Buffer.from(pem).toString('base64')
  console.log(c.bold + 'New PowerSync signing key (RSA-2048).' + c.reset)
  console.log('Set this in infra/compose/.env, then restart api + powersync:\n')
  console.log(`POWERSYNC_JWT_PRIVATE_KEY=${b64}\n`)
  console.log(warn('Rotating the key signs all NEW PowerSync tokens with it; existing client'))
  console.log(warn('tokens stay valid until they expire (~5 min), then refresh against the new key.'))
  console.log(c.dim + '\nApply with:  ./nook restart api powersync' + c.reset)
}

async function listHouseholds(): Promise<void> {
  const { rows } = await query<{ id: string; name: string; created_at: string; members: number; logins: number }>(
    `select h.id, h.name, h.created_at,
            (select count(*)::int from persons p where p.household_id = h.id and p.deleted_at is null) as members,
            (select count(*)::int from credentials c join persons p on p.id = c.person_id
              where p.household_id = h.id and c.deleted_at is null) as logins
       from households h
      order by h.created_at`
  )
  if (!rows.length) { console.log(c.dim + 'No households yet — this instance has not been set up.' + c.reset); return }
  for (const r of rows) {
    const created = new Date(r.created_at).toISOString().slice(0, 10)
    const logins = r.logins > 0 ? ok(`${r.logins} login${r.logins === 1 ? '' : 's'}`) : c.dim + 'no logins' + c.reset
    console.log(`  ${r.name.padEnd(18)} ${String(r.members).padStart(2)} member${r.members === 1 ? ' ' : 's'}  ${logins}  ${c.dim}${created}  ${r.id}${c.reset}`)
  }
  console.log()
}

async function deleteHousehold(): Promise<void> {
  const id = flag('id')
  if (!id) die('delete-household requires --id <uuid> (see `list-households`).')
  const hh = await query<{ name: string; members: number; logins: number }>(
    `select h.name,
            (select count(*)::int from persons p where p.household_id = h.id and p.deleted_at is null) as members,
            (select count(*)::int from credentials c join persons p on p.id = c.person_id
              where p.household_id = h.id and c.deleted_at is null) as logins
       from households h where h.id = $1`,
    [id]
  )
  const row = hh.rows[0]
  if (!row) die(`No household found with id "${id}".`)
  // A household with real logins is almost certainly not test debris — make the
  // operator say so explicitly with --force on top of the normal confirmation.
  if (row.logins > 0 && !has('force')) {
    die(`"${row.name}" has ${row.logins} login(s) — this looks like a real household.\n  Re-run with --force if you really mean to permanently delete it and everyone in it.`)
  }
  console.log(warn(`This permanently deletes "${row.name}" and ALL of its data`) + ` (${row.members} member(s), ${row.logins} login(s)).`)
  if (!(await confirm('This cannot be undone. Proceed?'))) die('Aborted.', 0)

  const client = await getPool().connect()
  let total = 0
  try {
    await client.query('begin')
    // Disable FK triggers for this transaction so we can delete in any order
    // (most household FKs are NO ACTION). Requires a superuser connection — the
    // compose Postgres role is one. `set local` auto-restores at commit.
    await client.query(`set local session_replication_role = replica`)
    // refresh_tokens is keyed by person, not household — clear it first.
    const rt = await client.query(`delete from refresh_tokens where person_id in (select id from persons where household_id = $1)`, [id])
    total += rt.rowCount ?? 0
    // Every table that carries a household_id, discovered dynamically so this keeps
    // working as the schema grows.
    const tables = await client.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'household_id'
          and t.table_type = 'BASE TABLE'`
    )
    for (const t of tables.rows) {
      const del = await client.query(`delete from "${t.table_name}" where household_id = $1`, [id])
      total += del.rowCount ?? 0
    }
    const h = await client.query(`delete from households where id = $1`, [id])
    total += h.rowCount ?? 0
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  console.log(ok(`✓ Deleted "${row.name}" and ${total} row(s) across the schema.`))
}

function help(): void {
  console.log(`${c.bold}Nook admin — operator / break-glass commands${c.reset}
${c.dim}Run as: ./nook admin <command> [flags]${c.reset}

  ${c.bold}list-members${c.reset}                       people, login email, admin/owner, password/SSO
  ${c.bold}reset-password${c.reset} --email <e> [--password <pw>] [--yes]
                                     set a member's password (random if omitted); revokes sessions
  ${c.bold}make-admin${c.reset}    (--email <e> | --person <uuid>)    grant admin
  ${c.bold}revoke-admin${c.reset}  (--email <e> | --person <uuid>)    revoke admin (not the owner)
  ${c.bold}password-login${c.reset} <on|off>             enable/disable email+password login
  ${c.bold}clear-calendar-error${c.reset} (--email <e> | --all) [--yes]
                                     clear a stuck Google account's sync-error flag
  ${c.bold}prune-sessions${c.reset} [--email <e>] [--yes]  revoke refresh tokens (one member, or all)
  ${c.bold}regenerate-powersync-key${c.reset}            print a fresh POWERSYNC_JWT_PRIVATE_KEY
  ${c.bold}list-households${c.reset}                     households with member + login counts
  ${c.bold}delete-household${c.reset} --id <uuid> [--force] [--yes]
                                     permanently delete a household + ALL its data

${c.dim}Destructive commands prompt for confirmation (or pass --yes).
Break-glass: set AUTH_FORCE_PASSWORD=1 in the api env + restart to force password login.${c.reset}`)
}

export const _cmds = { listMembers, resetPassword, makeAdmin, passwordLogin, clearCalendarError, pruneSessions, regeneratePowerSyncKey, listHouseholds, deleteHousehold }

async function main(): Promise<void> {
  const command = args()[0] ?? 'help'
  switch (command) {
    case 'list-members': await listMembers(); break
    case 'reset-password': await resetPassword(); break
    case 'make-admin': await makeAdmin(true); break
    case 'revoke-admin': await makeAdmin(false); break
    case 'password-login': await passwordLogin(); break
    case 'clear-calendar-error': await clearCalendarError(); break
    case 'prune-sessions': await pruneSessions(); break
    case 'regenerate-powersync-key': regeneratePowerSyncKey(); break
    case 'list-households': await listHouseholds(); break
    case 'delete-household': await deleteHousehold(); break
    case 'help': case '-h': case '--help': help(); break
    default: process.stderr.write(err(`Unknown command: ${command}`) + '\n\n'); help(); process.exitCode = 1
  }
}

// Auto-run as a CLI, but stay importable from tests (which set their own argv).
if (!process.env.VITEST) {
  main()
    .catch((e) => { process.stderr.write(err(`✗ ${e instanceof Error ? e.message : String(e)}`) + '\n'); process.exitCode = 1 })
    .finally(() => closePool().catch(() => {}))
}
