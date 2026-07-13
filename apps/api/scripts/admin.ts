// In-container operator CLI for break-glass / recovery without the web UI.
// Runs inside waffled-api (where DATABASE_URL + TOKEN_ENCRYPTION_KEY are set), so it
// reaches the DB directly — no HTTP, no admin token. Invoked as
//   ./waffled admin <command> [flags]   →   docker exec waffled-api node dist/admin.js …
//
// All auth-data writes go through the SAME service helpers the API uses
// (hashPassword / setPersonLogin), so there is one source of truth for hashing and
// the password→identity wiring. Destructive commands require an interactive "y"
// confirmation or the --yes flag.
//
// Commands (see `./waffled admin help`):
//   list-members
//   reset-password   --email <e> [--password <pw>] [--yes]
//   make-admin       (--email <e> | --person <uuid>)
//   revoke-admin     (--email <e> | --person <uuid>)
//   set-installation-owner --email <e> [--yes]
//   password-login   <on|off>
//   clear-calendar-error  (--email <e> | --all) [--yes]
//   prune-sessions   [--email <e>] [--yes]
//   regenerate-powersync-key
//   list-households
//   delete-household --id <uuid> [--force] [--yes]
import { createInterface } from 'node:readline'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { query, getPool, closePool } from '../src/platform/db'
import { setPersonLogin } from '../src/modules/auth/auth'

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

// Resolve a person (any one of their memberships) from a login email via their
// account — accounts are globally unique by email, so the email is unambiguous,
// but a human may belong to several households; this returns the earliest one for
// the household-scoped commands (make-admin / reset's display name).
async function personByLoginEmail(email: string) {
  const { rows } = await query<{ person_id: string; household_id: string; person_name: string }>(
    `select p.id as person_id, p.household_id, p.name as person_name
       from accounts a join persons p on p.account_id = a.id and p.deleted_at is null
      where lower(a.email) = lower($1) and a.deleted_at is null
      order by p.created_at
      limit 1`,
    [email]
  )
  return rows[0] ?? null
}

// Resolve a human account from an email — accounts hold the one source-of-truth
// password and unify a person's many household memberships.
async function accountByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const { rows } = await query<{ id: string; email: string }>(
    `select id, email from accounts where lower(email) = lower($1) and deleted_at is null limit 1`,
    [email]
  )
  return rows[0] ?? null
}

// Revoke every active session for an account across ALL its household memberships
// (a session's person_id is whichever membership was active when it was issued).
async function revokeAccountSessions(accountId: string): Promise<number> {
  const { rowCount } = await query(
    `update refresh_tokens set revoked_at = now()
      where revoked_at is null and person_id in (select id from persons where account_id = $1)`,
    [accountId]
  )
  return rowCount ?? 0
}

// Resolve a person by --email or --person, scoped to a real household.
async function resolvePerson(): Promise<{ id: string; household_id: string; name: string; is_admin: boolean }> {
  const email = flag('email')
  const personId = flag('person')
  if (email) {
    const person = await personByLoginEmail(email)
    if (!person) die(`No member found with login email "${email}".`)
    const { rows } = await query<{ is_admin: boolean }>(`select is_admin from persons where id = $1`, [person.person_id])
    return { id: person.person_id, household_id: person.household_id, name: person.person_name, is_admin: rows[0]?.is_admin ?? false }
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
            (select a.email from accounts a where a.id = p.account_id and a.deleted_at is null) as login_email,
            exists(select 1 from accounts a where a.id = p.account_id and a.deleted_at is null and a.password_hash is not null) as has_password,
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
  const person = await personByLoginEmail(email)
  if (!person) die(`No member found with login email "${email}".`)
  const provided = flag('password')
  if (provided && provided.length < 8) die('Password must be at least 8 characters.')
  const password = provided ?? generatePassword()
  if (!(await confirm(`Reset the password for ${c.bold}${person.person_name}${c.reset} (${email}) and sign out their active sessions?`))) {
    die('Aborted.', 0)
  }
  // Reuse the API's own helper: hashes with scrypt, writes accounts.password_hash
  // (the auth source of truth), and ensures a password identity exists.
  await setPersonLogin(person.household_id, person.person_id, email, password)
  // Revoke sessions across EVERY household the human belongs to.
  const account = await accountByEmail(email)
  if (account) await revokeAccountSessions(account.id)
  console.log(ok(`✓ Password reset for ${person.person_name} (${email}).`))
  if (!provided) console.log(`  New password: ${c.bold}${password}${c.reset}  ${c.dim}(give this to them; they can change it in Settings)${c.reset}`)
  console.log(c.dim + '  Active sessions across all their households were revoked — they must sign in again.' + c.reset)
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

async function setInstallationOwner(): Promise<void> {
  const email = flag('email')
  if (!email) die('set-installation-owner requires --email <login email>.')
  const account = await accountByEmail(email)
  if (!account) die(`No active account found with login email "${email}".`)
  if (!(await confirm(`Make ${c.bold}${account.email}${c.reset} the installation owner?`))) die('Aborted.', 0)
  const { rowCount } = await query(
    `update auth_config
        set installation_owner_account_id = $1, updated_at = now()
      where id = true`,
    [account.id]
  )
  if (!rowCount) die('No auth_config row found — run first-time setup before assigning an owner.')
  console.log(ok(`✓ ${account.email} is now the installation owner.`))
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
  if (email) {
    // Account-scoped: revoke across all the human's household memberships.
    const person = await personByLoginEmail(email)
    if (!person) die(`No member found with login email "${email}".`)
    const target = `${person.person_name} (${email})`
    if (!(await confirm(`Revoke ALL active sessions for ${c.bold}${target}${c.reset}? They will have to sign in again.`))) die('Aborted.', 0)
    const account = await accountByEmail(email)
    const revoked = account ? await revokeAccountSessions(account.id) : 0
    console.log(ok(`✓ Revoked ${revoked} active session(s) for ${target}.`))
    return
  }
  // No --email: revoke every active session for everyone.
  if (!(await confirm(`Revoke ALL active sessions for ${c.bold}all members${c.reset}? They will have to sign in again.`))) die('Aborted.', 0)
  const { rowCount } = await query(`update refresh_tokens set revoked_at = now() where revoked_at is null`)
  console.log(ok(`✓ Revoked ${rowCount ?? 0} active session(s) for all members.`))
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
  console.log(c.dim + '\nApply with:  ./waffled restart api powersync' + c.reset)
}

async function listHouseholds(): Promise<void> {
  const { rows } = await query<{ id: string; name: string; created_at: string; members: number; logins: number }>(
    `select h.id, h.name, h.created_at,
            (select count(*)::int from persons p where p.household_id = h.id and p.deleted_at is null) as members,
            (select count(*)::int from persons p join accounts a on a.id = p.account_id and a.deleted_at is null
              where p.household_id = h.id and p.deleted_at is null) as logins
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
            (select count(*)::int from persons p join accounts a on a.id = p.account_id and a.deleted_at is null
              where p.household_id = h.id and p.deleted_at is null) as logins
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

// Break-glass attach: add an EXISTING account to a household directly. This is the
// operator-side alternative to the web Households → invite-and-accept flow (host
// access is the authorization). The account must already exist — a human becomes an
// account the first time they sign in (password or SSO).
async function addMember(): Promise<void> {
  const email = flag('email')
  const householdId = flag('household-id')
  if (!email || !householdId) die('add-member requires --email <login email> and --household-id <uuid>.')

  const account = await accountByEmail(email)
  if (!account) {
    die(`No account uses "${email}". They must sign in once (password or SSO) first, or use the web Households → invite flow.`)
  }

  const hh = await query<{ name: string }>(`select name from households where id = $1 and deleted_at is null`, [householdId])
  if (!hh.rows[0]) die(`No household found with id "${householdId}".`)
  const householdName = hh.rows[0].name

  const existing = await query<{ one: number }>(
    `select 1 as one from persons where household_id = $1 and account_id = $2 and deleted_at is null limit 1`,
    [householdId, account.id]
  )
  if (existing.rows[0]) {
    console.log(c.dim + `${email} is already a member of "${householdName}" — no change.` + c.reset)
    return
  }

  const memberType = flag('member-type') || 'adult'
  const isAdmin = has('admin')
  if (!(await confirm(`Attach ${c.bold}${email}${c.reset} to "${householdName}" as ${memberType}${isAdmin ? ' (admin)' : ''}?`))) {
    die('Aborted.', 0)
  }

  // Carry over the human's existing display name if we have one.
  const nameRow = await query<{ name: string }>(
    `select name from persons where account_id = $1 and deleted_at is null order by created_at limit 1`,
    [account.id]
  )
  const displayName = nameRow.rows[0]?.name || email.split('@')[0]

  await query(
    `insert into persons (household_id, name, member_type, is_admin, account_id) values ($1, $2, $3, $4, $5)`,
    [householdId, displayName, memberType, isAdmin, account.id]
  )
  console.log(ok(`✓ Attached ${displayName} (${email}) to "${householdName}" as ${memberType}${isAdmin ? ' (admin)' : ''}.`))
}

// One human (account) → all the households they belong to.
async function listAccounts(): Promise<void> {
  const { rows } = await query<{ email: string; household: string; is_admin: boolean; is_owner: boolean }>(
    `select a.email, h.name as household, p.is_admin, (h.owner_person_id = p.id) as is_owner
       from accounts a
       join persons p on p.account_id = a.id and p.deleted_at is null
       join households h on h.id = p.household_id and h.deleted_at is null
      where a.deleted_at is null
      order by lower(a.email), h.name`
  )
  if (!rows.length) { console.log(c.dim + 'No accounts yet.' + c.reset); return }
  let lastEmail = ''
  for (const r of rows) {
    if (r.email !== lastEmail) { console.log(`\n${c.bold}${r.email}${c.reset}`); lastEmail = r.email }
    const role = r.is_owner ? c.cyan + 'owner' + c.reset : r.is_admin ? c.cyan + 'admin' + c.reset : c.dim + 'member' + c.reset
    console.log(`  ${ok(r.household)}  ${role}`)
  }
  console.log()
}

function help(): void {
  console.log(`${c.bold}Waffled admin — operator / break-glass commands${c.reset}
${c.dim}Run as: ./waffled admin <command> [flags]${c.reset}

  ${c.bold}list-members${c.reset}                       people, login email, admin/owner, password/SSO
  ${c.bold}reset-password${c.reset} --email <e> [--password <pw>] [--yes]
                                     set a member's password (random if omitted); revokes
                                     their sessions across ALL their households
  ${c.bold}add-member${c.reset} --email <e> --household-id <uuid> [--member-type adult|teen|kid] [--admin] [--yes]
                                     attach an existing account to a household (break-glass invite)
  ${c.bold}list-accounts${c.reset}                      each human and the households they belong to
  ${c.bold}make-admin${c.reset}    (--email <e> | --person <uuid>)    grant admin
  ${c.bold}revoke-admin${c.reset}  (--email <e> | --person <uuid>)    revoke admin (not the owner)
  ${c.bold}set-installation-owner${c.reset} --email <e> [--yes]       transfer/recover global login settings
  ${c.bold}password-login${c.reset} <on|off>             enable/disable email+password login
  ${c.bold}clear-calendar-error${c.reset} (--email <e> | --all) [--yes]
                                     clear a stuck Google account's sync-error flag
  ${c.bold}prune-sessions${c.reset} [--email <e>] [--yes]  revoke refresh tokens (one member across all
                                     their households, or everyone)
  ${c.bold}regenerate-powersync-key${c.reset}            print a fresh POWERSYNC_JWT_PRIVATE_KEY
  ${c.bold}list-households${c.reset}                     households with member + login counts
  ${c.bold}delete-household${c.reset} --id <uuid> [--force] [--yes]
                                     permanently delete a household + ALL its data

${c.dim}Destructive commands prompt for confirmation (or pass --yes).
Break-glass: set AUTH_FORCE_PASSWORD=1 in the api env + restart to force password login.${c.reset}`)
}

export const _cmds = { listMembers, resetPassword, makeAdmin, setInstallationOwner, passwordLogin, clearCalendarError, pruneSessions, regeneratePowerSyncKey, listHouseholds, deleteHousehold, addMember, listAccounts }

async function main(): Promise<void> {
  const command = args()[0] ?? 'help'
  switch (command) {
    case 'list-members': await listMembers(); break
    case 'reset-password': await resetPassword(); break
    case 'make-admin': await makeAdmin(true); break
    case 'revoke-admin': await makeAdmin(false); break
    case 'set-installation-owner': await setInstallationOwner(); break
    case 'password-login': await passwordLogin(); break
    case 'clear-calendar-error': await clearCalendarError(); break
    case 'prune-sessions': await pruneSessions(); break
    case 'regenerate-powersync-key': regeneratePowerSyncKey(); break
    case 'list-households': await listHouseholds(); break
    case 'delete-household': await deleteHousehold(); break
    case 'add-member': await addMember(); break
    case 'list-accounts': await listAccounts(); break
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
