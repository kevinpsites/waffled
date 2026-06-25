# Design spike — multi-household identity (account + membership)

**Status:** proposal / not built · **Raised:** 2026-06-25 · **Owner:** TBD

## 1. Problem

Today identity is fused to a single household:

- `credentials.email` has a **global** unique index (`uq_credentials_email` on
  `lower(email)`, no `household_id`) — an email exists once per deployment.
- A `persons` row belongs to **exactly one** household (`persons.household_id`), and
  login resolves `email → credential → person → household` with no household filter.

So **one email = one person = one household**. To be in two households you need two
emails. Fine for personal self-hosting; a real limitation for a hosted/sellable product
(co-parents across two families, a caregiver across families, an operator running a test
household beside their real one).

**Goal:** one human logs in once with one email and can belong to *many* households,
with a separate profile + role in each, switching between them after login — the model
Immich / Slack / Notion use.

## 2. The enabling insight (why this is tractable)

The household is **not carried in the access token** — it's looked up from the DB on
every request:

- `requireAuth` (`platform/auth.ts`) only verifies the JWT and sets `req.principal.sub`.
- `requireTenant` → `findTenantBySub(sub)` (`modules/households/households.ts`) does the
  `identities → persons → households` join and returns the `Tenant`
  (`{ sub, personId, householdId, isAdmin, memberType }`).
- `config.auth.householdClaim` (`'https://nook.app/household_id'`) is **defined but
  currently unused** — it was reserved for exactly this.

Consequence: the ~135 routes, all the FKs to `persons`, the capability matrix, the owner
rules, and PowerSync scoping **do not change**. The refactor concentrates in **one
resolver** (`findTenantBySub` → an account-aware `resolveTenant`) plus the login/issuance
flow. PowerSync already mints `{ household_id }` into its own token from
`tenant.householdId`, so it follows for free.

## 3. Design options

### Option A — full account + membership split (rejected)
Lift the profile fields out of `persons` into a `memberships` join
(`account × household × role + profile`), making `persons`/profile per-membership. Purest,
but rewrites every query and FK that touches `persons` (chores, goals, rewards, lists,
events, kiosk, …). Enormous blast radius for no extra capability. **Don't.**

### Option B — global account, `persons` stays the per-household membership (recommended)
Keep `persons` exactly as it is — it already *is* a per-household membership (household +
role `is_admin`/`member_type` + profile). Add a thin **global login layer** on top:

- New **`accounts`** table = the global human (email + password + the anchor for SSO
  identities). One row per person-who-logs-in, email globally unique.
- **`persons.account_id`** (nullable FK → `accounts`) links each household membership to
  the human. One account → many persons (≤1 per household). Kids / no-login persons keep
  `account_id = null`.
- Login authenticates the **account**, returns its memberships (the linked persons), the
  user picks one, and the access token carries which household is active.

Everything downstream stays person-scoped and unchanged. This is the plan below.

## 4. Target schema (additive)

```sql
-- The global human login. Email is the cross-household identity.
create table accounts (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text,                     -- null = SSO-only account
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index uq_accounts_email on accounts (lower(email)) where deleted_at is null;

-- Link each household membership (person) to the human, where one exists.
alter table persons add column account_id uuid references accounts(id);
create index ix_persons_account on persons (account_id) where deleted_at is null;
-- An account is in a household at most once.
create unique index uq_person_account_household on persons (account_id, household_id)
  where account_id is not null and deleted_at is null;
```

Disposition of existing tables:

- **`credentials`** is absorbed by `accounts` (email + password_hash move there). Keep the
  table during migration, then drop once `accounts` is authoritative. `setPersonLogin`
  becomes `setAccountLogin` (operates on the account; attaches/links a person-membership).
- **`identities`** becomes **account-scoped**: add `identities.account_id` (FK), backfill
  from `person → account`. `auth0_user_id` stays globally unique (one SSO sub → one
  account). Kiosk identities stay person-scoped (see §5.5).
- **`refresh_tokens`** keeps `person_id` (a session is into a *specific* active household),
  `subject` becomes the account id. No structural change needed.
- **`households.owner_person_id`**, the capability matrix, all per-domain FKs to `persons`:
  **unchanged**.

## 5. Auth flows

### 5.1 Token shape
Access token gains one claim — the **active membership**:
`mintAccess(accountSub, { [householdClaim]: householdId })` (finally using the reserved
`config.auth.householdClaim`). `resolveTenant` reads `sub` (account) + the household claim,
verifies a matching `persons` row links that account to that household, and builds the
`Tenant`. No household claim (legacy/kiosk) → fall back to "single membership" or the
person-anchored path.

### 5.2 Sign-up (first run) — unchanged shape
`provisionHousehold` also creates an `accounts` row and sets `persons.account_id`. Owner
stays `is_admin = true`, `owner_person_id` unchanged.

### 5.3 Login → membership picker
`POST /api/auth/login` resolves `email → account`, verifies the password, then:
- 1 membership → mint a token for it directly (today's behaviour, no UX change).
- N memberships → return the list `[{ householdId, name, personId, role }]`; the client
  shows a "Choose a household" step; a follow-up call mints the token for the chosen one.

### 5.4 Switch household
`POST /api/auth/switch { householdId }` — given a valid account session, mint a fresh
access+refresh pair for another membership the account owns (403 if not a member). The
SPA/iOS get a household switcher; PowerSync re-exchanges its token (new `household_id`).

### 5.5 SSO (OIDC) — invite to *existing* account
First SSO login matches the verified email to an `account` (not a person). If the account
is already a member of the target household → straight in. If not, the existing invite gate
applies (an admin must have added that email to the household first), then we link a new
`persons` membership to the account. Same email across households = same account.

### 5.6 Kiosk — unchanged
A kiosk is a shared device bound to one household; profiles include kids with no account.
Keep kiosk **person-anchored**: the kiosk token carries an explicit person+household and
`resolveTenant` supports a person-anchored token with no account. The lazy
`kiosk:<personId>` identity path is untouched.

### 5.7 PowerSync — free
`GET /api/powersync/token` already mints `{ household_id }` from `tenant.householdId`.
After a switch, the client re-fetches and gets the new household's sync token.

## 6. The single code seam

From the current map, household originates in exactly these places — each is a known edit:

| Path | Today | After |
| --- | --- | --- |
| Password login | `email → credential → person` | `email → account → membership(s)` |
| OIDC callback/exchange | match email → person | match email → **account** → membership |
| Kiosk profile | `kiosk:<personId>` identity | unchanged (person-anchored) |
| Device token | `{ household_id }` claim | unchanged |
| **Every data route** | `findTenantBySub(sub)` | `resolveTenant(sub, householdClaim)` |

`findTenantBySub` → `resolveTenant` is the one hot path; everything else is the auth module.

## 7. Migration (additive, phased, never destructive)

Per the self-host rules (additive migrations only; **never wipe volumes**):

1. **Migration N:** create `accounts`, add `persons.account_id`, add `identities.account_id`.
2. **Backfill (idempotent):** for each `credentials` row → upsert an `accounts` row by
   `lower(email)` (carry `password_hash`), set `persons.account_id`; for SSO `identities`
   with an email but no credential → upsert an account by email and link. Emails are
   globally unique today, so backfill is 1:1 and safe.
3. **Ship the account-aware auth module** behind the same endpoints (single-membership
   accounts behave exactly as today — zero UX change until someone is added to a 2nd
   household).
4. **Later cleanup migration:** once `accounts` is authoritative, drop `credentials`
   (or keep as a view) and the now-redundant per-person email columns.

Rollback: steps 1–2 are pure additions; the old code keeps working until step 3.

## 8. Operator CLI impact (clarifies the earlier question)

- **`reset-password`** becomes **account-scoped** — one password for the human across all
  their households (this is the right behaviour and resolves the "which household?"
  ambiguity).
- **`make-admin` / `revoke-admin`** stay **membership-scoped** (`persons.is_admin`) — you
  can be admin in one household and not another. Already correct.
- New candidate: **`add-member --email --household`** — attach an existing account to
  another household from the CLI (the break-glass version of an invite).
- `list-members` would show the account email per membership; a future `list-accounts`
  could show one human and all their households.

## 9. Open decisions (need product input)

1. **Join consent:** when an existing account is added to a 2nd household, do they
   auto-appear there, or must they accept an invite first?
2. **Email change / merge:** if two accounts should be one human (legacy duplicates), do we
   need an account-merge tool, or is that out of scope?
3. **Default household:** on login with N memberships, remember the last active one, or
   always show the picker?
4. **Self-service "create another household":** can any logged-in account spin up a new
   household (becoming its owner), or is that admin/operator-gated?
5. **iOS:** the mobile app needs the same picker/switch — coordinate with the mobile owner
   (PowerSync re-exchange on switch is the main touch point).

## 10. Effort / phasing

- **P1 — schema + backfill migration** (additive; no behaviour change). Small.
- **P2 — account-aware auth module**: `accounts` model, `resolveTenant`, login picker,
  `/api/auth/switch`, OIDC match-by-account. Medium; concentrated in `modules/auth` +
  `households.ts`. Integration tests reuse the Testcontainers harness.
- **P3 — clients**: web household switcher + post-login picker; iOS switcher.
- **P4 — CLI + cleanup**: `add-member`, account-scoped `reset-password`, drop `credentials`.

## 11. Out of scope (for now)

Option A (per-membership profiles), account-merge tooling, org/team hierarchies above
household, per-household *email* aliases for one account.
