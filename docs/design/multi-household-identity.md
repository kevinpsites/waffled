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
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  password_hash     text,                 -- null = SSO-only account
  last_household_id uuid references households(id),  -- decision 3: land here on next login
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create unique index uq_accounts_email on accounts (lower(email)) where deleted_at is null;

-- Link each household membership (person) to the human, where one exists.
alter table persons add column account_id uuid references accounts(id);
create index ix_persons_account on persons (account_id) where deleted_at is null;
-- An account is in a household at most once.
create unique index uq_person_account_household on persons (account_id, household_id)
  where account_id is not null and deleted_at is null;

-- Decision 1: adding an existing account to another household is a pending invite the
-- account must accept (not an instant membership). Accepting creates the persons row.
create table household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  email        text not null,             -- the invited login email
  member_type  text not null default 'adult',
  is_admin     boolean not null default false,
  invited_by   uuid references persons(id),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
create index ix_household_invites_email on household_invites (lower(email))
  where accepted_at is null and revoked_at is null;
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

### 5.3 Login → land on last-active (decision 3)
`POST /api/auth/login` resolves `email → account`, verifies the password, then:
- 1 membership → mint a token for it directly (today's behaviour, no UX change).
- N memberships → mint for `accounts.last_household_id` if still valid, else the most
  recent; return the membership list too so the client can show a switcher. The response
  also includes any **pending invites** (decision 1) so the client can prompt to accept.
No forced picker on every login.

### 5.4 Switch household
`POST /api/auth/switch { householdId }` — given a valid account session, mint a fresh
access+refresh pair for another membership the account owns (403 if not a member) and set
`accounts.last_household_id`. The SPA/iOS get a household switcher; PowerSync re-exchanges
its token (new `household_id`).

### 5.5 Adding a member / SSO — invite-and-accept (decision 1)
Adding an email that maps to an **existing account** creates a `household_invites` row, not
an instant membership. The account sees it on next login (or in a notifications area) and
accepts → we create the `persons` membership linked to the account. Adding an email with
**no account yet** behaves as today (email-only invite; the account is created on first
password/SSO sign-in, which then auto-accepts the matching invite).

First **SSO** login matches the verified email to an `account` (not a person). Already a
member of the target household → straight in. Otherwise the email must have a pending
invite (the admin added it) → accepting links a new `persons` membership. Same email across
households = same account.

### 5.8 Create a household — admin-gated (decision 4)
`POST /api/households` (new, for an existing session) provisions a new household with the
caller as owner — **allowed only if the caller is already an admin of some household**
(`tenant.isAdmin`). The new household reuses `provisionHousehold`, linking the existing
`account_id` rather than creating a new account. Open self-serve onboarding (any signed-up
user creates a household) is deferred to the sell-time lift (§11).

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

## 9. Resolved decisions (aligned 2026-06-25)

1. **Join consent → accept invite first.** Adding an existing account's email to a 2nd
   household creates a **pending invite**, not an instant membership — the account sees it
   on next login and taps to accept. No one can attach your account to their household
   without your OK. Adds a small `household_invites` table + an accept endpoint (see §4/§5.5).
2. **Account merge → out of scope.** Emails are globally unique today, so the backfill is
   1:1 and no duplicate accounts can exist. No merge tooling until a real need appears.
3. **Default household → remember last, skip if only one.** Single-membership accounts go
   straight in (zero UX change from today). Multi-membership accounts land in their
   last-active household with a switcher; no forced picker every login. Store
   `accounts.last_household_id` (nullable).
4. **Create household → admin-gated, not open self-serve.** Creating a new household (and
   becoming its owner) requires the actor to already be an admin somewhere. Full self-serve
   onboarding ("any signed-up user spins up a household") is deferred and treated as a
   separate lift to scope **if/when we go to sell** — flagged in §11.

**Coordination note (not a decision):** iOS needs the same post-login picker + household
switcher; the main touch point is re-exchanging the PowerSync token on switch. Hand to the
mobile owner when P3 starts.

## 10. Effort / phasing

- **P1 — schema + backfill migration** (additive; no behaviour change): `accounts`,
  `persons.account_id`, `identities.account_id`, `household_invites`,
  `accounts.last_household_id`. Small. **SHIPPED 2026-06-25** — migrations
  `0055_accounts.sql` (accounts + persons/identities links + idempotent 1:1 backfill
  from credentials & SSO identities) and `0056_household_invites.sql`. Covered by
  `test/accounts.integration.test.ts` and `test/household-invites.integration.test.ts`
  (Testcontainers; backfill exercised by migrating to just-before then seeding legacy
  rows). No runtime behaviour change yet — the auth module still reads `credentials`.
- **P2 — account-aware auth module**: `accounts` model, `resolveTenant` (sub + household
  claim), login → last-active (decision 3), `/api/auth/switch`, invite-and-accept
  (`household_invites`, decision 1), OIDC match-by-account, admin-gated `POST /api/households`
  (decision 4). Medium; concentrated in `modules/auth` + `households.ts`. Integration tests
  reuse the Testcontainers harness. **SHIPPED 2026-06-25** in six commits (P2.1–P2.6):
  account-aware `resolveTenant` + accounts on signup; account login landing on last-active
  with memberships + refresh upgrade; `POST /api/auth/switch`; invite-and-accept
  (`/api/households/invites` + `/api/auth/invites[/:id/accept]`); OIDC match-by-account with
  identity→account linking + pure-invite SSO onboarding; admin-gated `POST /api/households`
  (self-serve onboarding deferred → 403, first household via `/api/auth/setup`). New tests:
  `resolve-tenant`, `account-login`, `auth-switch`, `invites`, `oidc-account`, plus the
  rewritten `provisioning` suite. **Zero UX change for single-membership accounts.**
- **P3 — clients**: web household switcher + last-active landing + pending-invite accept;
  iOS switcher (coordinate with mobile owner; PowerSync re-exchange on switch).
- **P4 — CLI + cleanup**: account-scoped `reset-password`, membership-scoped `make-admin`,
  `add-member --email --household` (creates an invite), drop `credentials` (or keep as view).

## 11. Out of scope (for now)

Option A (per-membership profiles), account-merge tooling (decision 2), org/team hierarchies
above household, per-household *email* aliases for one account.

**Deferred to a sell-time lift (decision 4):** full self-serve onboarding — a brand-new
visitor signs up and creates their own household with no existing admin. This brings its own
scope (public sign-up flow, abuse/rate limits, billing/tenant isolation, email verification
for unknown addresses) and is intentionally separated from the in-family multi-household work
above, which only lets an **existing admin** create additional households.
