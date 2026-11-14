# MCP server — let an AI agent query and act on a household

**Status:** planned, not started. **Written:** 2026-11-13.
**Scope agreed:** the endpoint (§2), the tools (§3), sign-in through the normal Waffled
login (§4), the safety rules (§5) and change-notification tier A (§6), one PR each (§7).
Web + api first; iOS after.

The goal: a family member connects Claude (claude.ai connectors, Claude Desktop, Claude
Code, or any MCP client) to their Waffled server, signs in the way they sign in to the
app, and can then ask "what's for dinner Thursday?", "what chores are still open for the
kids?", or say "add milk to the grocery list" / "move soccer to 5pm".

---

## 1. What already exists (and is reused, not rebuilt)

| Piece | Where | Role in MCP |
|---|---|---|
| User login (password + OIDC) issuing an access JWT + rotating refresh token | `modules/auth/auth.ts` (`/api/auth/login`, `/refresh`), `modules/auth/oidc.ts` | The sign-in step of the OAuth flow (§4) |
| Account → household → person resolution | `resolveTenant` / `requireTenant` (`modules/households/households.ts`) | Every tool call runs as a resolved `Tenant` |
| Capability matrix (per role, per person) | `platform/permissions.ts`, `capRoute` in `platform/route-guards.ts` | A teen's agent can never do more than the teen |
| Scope catalog `<resource>:read\|write`, fail-closed | `API_SCOPES` in `modules/api-keys/api-keys.ts` | The consent screen offers these; tools declare one |
| Per-household module toggles | `platform/modules.ts` | A disabled module's tools are hidden from `tools/list` |
| Capture mutate verbs (resolve → commit) | `modules/capture/capture-resolvers.ts` + `*-capture.ts` per domain | The write tools — "find the right row" is already solved |
| Per-user API keys | `modules/api-keys/` | Kept as a developer/testing path (no extra work) |

What does **not** exist: an MCP endpoint, an OAuth *authorization server* (we only have an
OIDC *client*), and any change history / notification plumbing.

---

## 2. The endpoint

**`/mcp` lives inside the existing api process**, not a new service. Reasons: it inherits
the auth gate in `app.ts`, and it ships everywhere the api already ships (compose, the Mac
runtime, Lambda) with no new compose service, supervisor entry or esbuild bundle. Caddy
needs one `handle /mcp*` (plus the `/.well-known/oauth-*` paths, §4) next to `/api/*`.

- **Transport:** Streamable HTTP, **stateless** (each POST is a self-contained JSON-RPC
  call). No session store, so it works on Lambda and behind any number of api replicas.
- **Hand-rolled, no SDK:** `/mcp` is a normal lambda-api route, so it stays behind the
  auth gate. Intercepting it in `platform/http-server.ts` (which the SDK's Node transport
  would need) would skip the gate, `PUBLIC_PATHS` and the Lambda entry. `initialize`,
  `ping`, `tools/list` and `tools/call` over plain JSON responses are a few hundred lines.
- **API keys on `/mcp`:** the central `enforceApiKeyScope` fails closed on any path outside
  `API_SCOPES`, so `/mcp` needs an exact-path carve-out where the tool registry's per-tool
  scope check is the gate. Keys arrive as `x-api-key` or, on `/mcp` only,
  `Authorization: Bearer waffled_…` (what MCP clients send).
- **Tools call service functions directly**, never HTTP back into our own routes. Each
  tool gets the same `Tenant` and runs the same capability check a route would.

---

## 3. The tools

Each tool is declared once with its scope, so scope lives on the tool rather than on a path
prefix (the problem `api-key-scopes-plan.md` §3 describes cannot recur here):

```ts
defineTool({
  name: 'complete_chore',
  scope: 'chores:write',
  module: 'chores',
  annotations: { destructiveHint: false },
  input: { /* JSON Schema */ },
  run: (tenant, args) => choresTarget.applyMutation(ctxFor(tenant), { verb: 'complete', ...args }),
})
```

**Composite reads** (`get_today`) declare `family:read` and include each section only when
the caller also holds that section's scope, so a read never widens what a grant covers.

A guard test walks the tool registry and fails on any tool without a `scope` (fail-closed,
same idea as the route-table test in `api-keys.integration.test.ts`).

**Read (first cut):** `get_today` (overview), `list_events(from, to)`, `list_chores(status,
person)`, `get_grocery_list`, `get_meal_plan(week)`, `list_goals` (the display axis —
`periodDone` for habits, steps for checklists — never raw `totalProgress`), `get_reward_balances`, `list_family`, `search_recipes`.

**Write (first cut):** the capture verbs — `complete`, `log`, `reschedule`, `reassign`,
`redeem`, `delete` — exposed as a `find_*` tool returning candidates (`resolveCandidates`)
plus an action tool taking the chosen id (`applyMutation`), so the agent confirms ambiguity
with the user instead of guessing. Plus create tools: `add_event`, `add_list_item`,
`plan_meal`, `create_chore`. These are **not** capture verbs: each needs its create logic
lifted out of its route handler into a service function the route and the tool share.

**Weeks:** every week-shaped tool takes or returns the **server's** week key (household
`week_start`), never a client-computed one.

**Natural-language questions need no LLM on our side** — the agent reads with the tools
and answers. `platform/llm.ts` is not involved.

**Out of scope for v1:** Weekly Planning (an interactive ritual; product call still open,
see `api-key-scopes-plan.md` §4), settings, auth, invites, admin, photos upload.

---

## 4. Auth — sign in like a user (works with claude.ai connectors)

**Yes, this uses the same login as the app.** Claude connectors require the MCP
authorization spec (2025-11-25): OAuth 2.1 with PKCE. In that flow the user is sent to a
browser page *we* serve to sign in, so that page is simply the existing Waffled login —
password or Google/OIDC — followed by a consent screen. Nobody copies a key anywhere.

### The flow

1. Client calls `/mcp` without a token → **401** with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="…"`.
   (Claude ignores the header on any other status.)
2. **Protected-resource metadata** (RFC 9728), served at both the path-inserted
   `/.well-known/oauth-protected-resource/mcp` and the root: `resource` = the exact MCP URL
   (`<origin>/mcp`, no trailing slash), one `authorization_servers` entry (Claude uses only
   the first), `scopes_supported`.
3. **Authorization-server metadata** (RFC 8414, `/.well-known/oauth-authorization-server`):
   `code_challenge_methods_supported: ["S256"]` (clients refuse without it),
   `token_endpoint_auth_methods_supported: ["none"]`,
   `client_id_metadata_document_supported: true`, plus the endpoints.
4. **Client registration**, both ways Claude uses:
   - **Client ID Metadata Documents** (preferred by the spec): the `client_id` is an HTTPS
     URL; we fetch it (HTTPS only, no private addresses, size and time limits, cached per
     HTTP headers), require `client_id` to equal the URL and the requested `redirect_uri` to
     exactly match its list. Claude Code publishes one with loopback redirects, whose port
     varies.
   - **Dynamic Client Registration** (RFC 7591, `POST /api/oauth/register`, JSON). Claude
     registers a fresh public client on every new connection, so unused registrations are
     pruned.
   - Redirect URIs must be HTTPS or loopback. claude.ai, Desktop and mobile all use
     `https://claude.ai/api/mcp/auth_callback`.
5. Browser opens `/oauth/authorize?…&code_challenge=…&resource=<origin>/mcp` — a **web SPA
   route**:
   - not signed in → the **existing login screen** (password or OIDC; the OIDC return
     router-navigates back to `/oauth/authorize`);
   - signed in → **consent**: client name and the redirect URI's **hostname** (the spec
     requires showing it), household picker for multi-household accounts, and scope
     checkboxes. Only scopes some registered tool uses are offered, each with a plain
     sentence of what it allows; reads on by default, writes opt-in.
   - the person lacks the `ai.connect` capability → a refusal page, no code issued.
6. Approve → `POST /api/oauth/authorize` (authenticated with the user's normal session)
   stores a one-time code bound to client, redirect URI, PKCE challenge, `resource`, person,
   household and scopes, then redirects to the `redirect_uri`.
7. Client → `POST /api/oauth/token` (form-encoded; `authorization_code` + verifier +
   `resource`, later `refresh_token`) → an MCP access token + a refresh token. A dead refresh
   token answers `invalid_grant`.

### The tokens — confined by audience, stored apart

- **Access token:** a new `mintMcpAccess`, not `mintAccess`. `mintAccess` hard-sets the
  configured audience, and the normal `requireAuth` verifies against it — which is exactly
  what confines an MCP token: its `aud` is `<origin>/mcp`, so **every REST route rejects it
  with 401** with no further code. `/mcp` gets its own verify path that accepts only that
  audience (canonical form: lowercase host, no trailing slash) and reads `scope`,
  `grant_id`. Short-lived.
- **Refresh tokens live in their own table** (`oauth_refresh_tokens`, keyed to an
  `oauth_grants` row: client, person, household, scopes, created, last used, revoked), never
  in `refresh_tokens`. So `/api/auth/refresh` cannot turn a connector's refresh token into
  a full user session, and rotation keeps the `grant_id`. Rotation on every use (the spec
  requires it for public clients).
- **Scope gate:** `/mcp` keeps the per-tool check from §3. A token holding a scope no tool
  uses grants nothing, because MCP tokens reach nothing but `/mcp`.
- **Revocation:** **Settings → Connected apps** lists grants and revokes them, beside
  Settings → API Keys. Revoking kills the grant's refresh tokens; the short access-token TTL
  bounds the rest, and `/mcp` checks the grant is unrevoked on each call.

### Who may connect

A new capability **`ai.connect`** in the permissions matrix (default: adults on, kids off;
admins can change it per role like any other). It is checked at consent, on every refresh,
and on every `/mcp` call — so turning it off takes effect within one call, not at the next
login.

### Reach — the limit to say out loud

**claude.ai connectors (and Duet, mobile, Desktop's hosted connectors) call from
Anthropic's cloud.** Both the MCP host and the auth host must be **public HTTPS with an
IPv4 A record** — private, CGNAT and loopback addresses are refused, and the MCP URL must
not redirect to another host. Most compose and Mac installs are LAN-only today, so those
households **finish this phase and still cannot use claude.ai** until they give Waffled a
public hostname (a tunnel, or a domain with Caddy TLS like `demo.waffled.app`; the Mac's
"a hostname Caddy actually serves" is still planned in `mac-settings-redesign.md`). Claude
Code and local MCP clients work on the LAN. The how-to must lead with this.

### Still to settle while building

- **Origins behind Caddy:** build every metadata URL from `PUBLIC_BASE_URL` or the
  forwarded Host/Proto, the way `oidc.ts` does.
- **Auth0 mode:** v1 targets local mode (the self-host default). In Auth0 mode the
  authorization server would be Auth0's, so the metadata points there instead; decide
  later.

---

## 5. Safety

- **Two gates, same as API keys:** scope (granted at consent) and capability (the
  person's role). Neither is new.
- **Destructive tools** (`delete`, `redeem`) carry `destructiveHint: true` so clients
  confirm; `delete` on a recurring series states the scope in its result.
- **Attribution without touching every table:** a new `mcp_audit` table written by the
  tool registry — tool, caller (`api_key_id` or `grant_id`), person, target ids, outcome,
  time. One migration, no `source` column on events, chores, list items or meal plans.
  It ships **with the write tools**, keyed by API key until grants exist, so there is no
  window of untraceable agent writes.
- **Rate limits** per key or grant on `tools/call`.
- **Prompt injection:** household text (list items, event notes, recipe bodies) reaches
  the agent as data. Tool descriptions say so; tools return structured fields, not
  free-form prose that mixes data and instructions.
- **No secrets in tool output:** never return tokens, OIDC config, invite codes or other
  members' account emails.

---

## 6. Change notifications — tier A in this stack, B and C deferred

What they would add: MCP by itself is pull-only, so the agent learns things only when
asked. Notifications would let an agent *react* ("tell me when the kids finish their
chores", a morning digest of what changed, nudging when a reward is redeemed).

**Proactive agents poll.** Claude Duet (research preview, 2026-10) checks connected
accounts every few hours rather than holding a connection open. What it needs from us is a
cheap, accurate "what changed since my last check" read, not push. Three tiers:

| Tier | What | Size |
|---|---|---|
| A | `whats_new(since)` read tool derived from existing columns: every domain table already has `household_id`, `updated_at`, soft-delete `deleted_at`; plus `chore_instances.completed_at`, goal logs and ledger entries (stars earned/spent). No migration. | ~2–3 days, fits in phase 1 |
| B | A real change log: one generic trigger (same pattern as `set_updated_at`) on ~15 tables into `household_changes` (cursor, entity, op, changed columns, actor, source), a pruning job beside the existing schedulers in `server.ts`, and `changes_since(cursor)`. Catches all three write paths (REST, PowerSync uploads, calendar sync) and gives "who changed what". | ~1 week |
| C | Push: webhooks per grant, or MCP resource subscriptions over SSE fed by LISTEN/NOTIFY. No current client benefits. | ~1 week, skip |

Tier A's limits: it reports current state, so an edit shows as "updated" without what
changed or who did it, and hard deletes are invisible (most tables soft-delete). Tier B's
hard part is **actor attribution**: a trigger only knows the actor if the write path sets
it (`set_config('waffled.actor', …, true)` inside the transaction), so each of the three
write paths needs that one line.

**Both tiers must filter by what the reading person may see.** A private calendar event
(`0074_calendar_visibility`) must not leak through the feed to another member's agent, so
the feed reuses each module's read filters rather than returning raw rows.

---

## 7. The PR stack

Web + api only; iOS (Connected apps in Settings, any native consent) follows after.
Each PR is based on the previous one and ships its own tests, changelog line and docs.

| PR | Section | Delivers | Size |
|---|---|---|---|
| plan | — | this document | — |
| 1 | §2 | `/mcp` endpoint (stateless JSON-RPC, version + Origin checks), tool registry with per-tool scopes + guard tests, the `/mcp` API-key carve-out, one `whoami` tool. Usable from Claude Code with an API key sent as `Authorization: Bearer waffled_…`. | ~2–3 days |
| 2 | §3 | Read tools, `find_*` + capture-verb write tools, create tools (service functions lifted out of their routes), `mcp_audit`. | ~1–2 weeks |
| 3 | §4 | OAuth 2.1: metadata, CIMD + DCR, authorize/token, `mintMcpAccess` + the `/mcp` verify path, `oauth_grants` / `oauth_refresh_tokens`, `ai.connect`, web consent route, Settings → Connected apps, the "Connect Claude" how-to. | ~2 weeks |
| 4 | §5 | Rate limits, injection-safe tool descriptions, the secrets-in-output guard test; audit gains `grant_id`. | ~2–3 days |
| 5 | §6 A | `whats_new(since)`, filtered through each module's read rules; roadmap item → Done. | ~2–3 days |
