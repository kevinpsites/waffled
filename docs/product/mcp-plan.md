# MCP server — let an AI agent query and act on a household

**Status:** in progress — §2 (the endpoint) and the §3 registry are built, with one `whoami`
tool and API-key auth; the real tools and §4 sign-in are next. **Written:** 2026-11-13.
**Scope agreed:** the endpoint (§2), the tools (§3), sign-in through the normal Waffled
login (§4) and the safety rules (§5). Change notifications (§6) are **deferred**.

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

**`/mcp` lives inside the existing api process**, not a new service. It is an ordinary
lambda-api route (`modules/mcp/mcp.ts`), so it passes through the auth gate in `app.ts` and
ships everywhere the api already ships (compose, the Mac runtime, Lambda) with no new
compose service, supervisor entry or esbuild bundle. Caddy has a `handle @mcp` block
(`path /mcp /mcp/*`, same forwarding headers as `/api/*`); the Mac runtime copies that
Caddyfile verbatim, and the Vite dev proxy forwards `/mcp` too.

- **Transport:** Streamable HTTP, **stateless**: one JSON-RPC message per POST, one
  `application/json` answer, no session id, no SSE. Works on Lambda and behind any number
  of api replicas. `GET`/`DELETE /mcp` → 405 (`Allow: POST`).
- **Hand-rolled, no SDK.** `initialize`, `ping`, `tools/list`, `tools/call` are a few
  hundred lines; the SDK's transport wants Node `req`/`res`, which would have meant
  intercepting `/mcp` ahead of lambda-api and outside the auth gate.
- **Protocol versions:** `2025-03-26`, `2025-06-18`, `2025-11-25`. `initialize` echoes the
  client's version if supported, else answers `2025-11-25`. On later requests an
  unsupported `MCP-Protocol-Version` header → HTTP 400; an absent one is accepted.
- **Origin:** a browser `Origin` that is not this server's own origin (`PUBLIC_BASE_URL`,
  else the forwarded host/proto — the same `baseUrl` OIDC uses) → 403. No `Origin` passes:
  server-to-server clients send none.
- **Errors:** unparseable JSON → `-32700`; a bad envelope → `-32600`; **batches** (a JSON
  array) → `-32600` with HTTP 400, since 2025-06-18 dropped batching; unknown method →
  `-32601`; unknown tool → `-32602`. Notifications and client responses → 202, no body.
  A tool's own failures (bad arguments, missing scope, module off, capability denied) are
  a tool result with `isError: true` so the model can see and react to them.
- **Auth (until §4 lands):** a user Bearer JWT carries the person's full rights; an API key
  (`x-api-key`, or `Authorization: Bearer waffled_…` on `/mcp` only) is bounded by its
  scopes. The central key gate is path-based and fails closed, so `/mcp` — and only that
  exact path — is listed in `SCOPED_PER_CALL` in `api-keys.ts`: the gate skips its path
  check there and the registry checks each tool's scope instead. A route-table guard test
  requires every such path to be live and claimed by no scope prefix or deny entry.
- **Tools call service functions directly**, never HTTP back into our own routes. Each
  tool gets the resolved `Tenant` (`requireTenant`) and runs the same capability check a
  route would.

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
  inputSchema: { type: 'object', properties: { /* JSON Schema */ } },
  run: (tenant, args) => choresCapture.commit(tenant, 'complete', args),
})
```

A guard test walks the tool registry and fails on any tool whose `scope` is not a real
`API_SCOPES` string (fail-closed, same idea as the route-table test in
`api-keys.integration.test.ts`). `tools/list` and `tools/call` share one predicate
(`denialFor` in `modules/mcp/registry.ts`): a tool the caller's scopes don't cover, or whose
`module` is off for the household, is hidden from the list and refused on call.

**Read (first cut):** `get_today` (overview), `list_events(from, to)`, `list_chores(status,
person)`, `get_grocery_list`, `get_meal_plan(week)`, `list_goals` (the display axis —
`periodDone` for habits, steps for checklists — never raw `totalProgress`), `get_reward_balances`, `list_family`, `search_recipes`.

**Write (first cut):** the capture verbs — `complete`, `log`, `reschedule`, `reassign`,
`redeem`, `delete` — exposed as a `find_*` tool returning candidates (`resolveCandidates`)
plus an action tool taking the chosen id, so the agent confirms ambiguity with the user
instead of guessing. Plus create tools: `add_event`, `add_list_item`, `plan_meal`,
`create_chore`.

**Weeks:** every week-shaped tool takes or returns the **server's** week key (household
`week_start`), never a client-computed one.

**Natural-language questions need no LLM on our side** — the agent reads with the tools
and answers. `platform/llm.ts` is not involved.

**Out of scope for v1:** Weekly Planning (an interactive ritual; product call still open,
see `api-key-scopes-plan.md` §4), settings, auth, invites, admin, photos upload.

---

## 4. Auth — sign in like a user (works with claude.ai connectors)

**Yes, this uses the same login as the app.** Claude connectors require the MCP
authorization spec, which is OAuth 2.1 with PKCE. In that flow the user is sent to a
browser page *we* serve to sign in, so that page is simply the existing Waffled login —
password or Google/OIDC, whichever the household uses — followed by a consent screen.
Nobody copies a key anywhere.

### The flow

1. Client calls `/mcp` without a token → `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
2. Client reads **protected-resource metadata** (RFC 9728) → points at our
   **authorization-server metadata** (RFC 8414, `/.well-known/oauth-authorization-server`).
3. Client **registers** itself: Dynamic Client Registration (RFC 7591,
   `POST /api/oauth/register`); also accept Client ID Metadata Documents, which newer
   clients prefer. Stored in a new `oauth_clients` table.
4. Browser opens `/oauth/authorize?…&code_challenge=…` — a **web SPA route**:
   - not signed in → the **existing login screen** (password or OIDC; the OIDC return
     router-navigates back to `/oauth/authorize`);
   - signed in → **consent**: client name and redirect host, household picker (accounts with
     several households), scope checkboxes from `API_SCOPES` (read scopes on by default,
     writes opt-in).
5. Approve → `POST /api/oauth/authorize` (authenticated with the user's normal session)
   stores a one-time code bound to client, PKCE challenge, person, household and scopes,
   then redirects to the client's `redirect_uri` (exact-match against registration).
6. Client → `POST /api/oauth/token` (`authorization_code` + verifier, later
   `refresh_token`) → our own access JWT + a refresh token.

### The tokens

- **Access token:** minted by the same `mintAccess` as a normal login, plus `scope`,
  `client_id` and `aud = <origin>/mcp`. Short-lived.
- **Refresh token:** the existing `refresh_tokens` table with rotation, extended with a
  `grant_id` → new `oauth_grants` row (client, person, household, scopes, created,
  last used, revoked).
- **Scoped tokens are confined like API keys.** The auth gate treats any principal carrying
  a `scope` claim exactly as it treats an `x-api-key` request: generalize
  `enforceApiKeyScope` to "scoped principal". An agent token therefore cannot be replayed
  against the full REST API with the user's full rights, and the `aud` check stops it from
  being used anywhere but `/mcp`.
- **Revocation:** **Settings → Connected apps** lists grants and revokes them, beside
  Settings → API Keys.

### Gotchas to settle while building

- **claude.ai connectors call from Anthropic's cloud**, so the server must be reachable on
  public HTTPS (a domain + Caddy TLS like `demo.waffled.app`, or a tunnel). A LAN-only
  install still works with Claude Desktop/Code and local clients. Say this in the how-to.
- **Redirect URIs:** allow the claude.ai / claude.com connector callbacks; check the
  current values in Anthropic's connector docs at build time rather than hard-coding them
  from memory.
- **Origins behind Caddy:** build every metadata URL from the forwarded Host/Proto, the way
  `oidc.ts` already does.
- **Auth0 mode:** v1 targets local mode (the self-host default). In Auth0 mode the
  authorization server would be Auth0's, so the metadata points there instead; decide
  later.
- **Who may connect:** an admin household setting "members can connect AI apps" (default
  on for adults, off for kids).

---

## 5. Safety

- **Two gates, same as API keys:** scope (granted at consent) and capability (the
  person's role). Neither is new.
- **Destructive tools** (`delete`, `redeem`) carry `destructiveHint: true` so clients
  confirm; `delete` on a recurring series states the scope in its result.
- **Attribution:** every write records `source = 'mcp'` and the `grant_id`, so agent edits
  are visible and traceable.
- **Rate limits** per grant on `tools/call`.
- **Prompt injection:** household text (list items, event notes, recipe bodies) reaches
  the agent as data. Tool descriptions say so; tools return structured fields, not
  free-form prose that mixes data and instructions.
- **No secrets in tool output:** never return tokens, OIDC config, invite codes or other
  members' account emails.

---

## 6. Change notifications — deferred (tier A may join phase 1)

What they would add: MCP by itself is pull-only, so the agent learns things only when
asked. Notifications would let an agent *react* ("tell me when the kids finish their
chores", a morning digest of what changed, nudging when a reward is redeemed).

Why deferred: today's hosted clients (claude.ai) do not hold an open session to receive
server pushes, so push would mainly serve scheduled or long-running agents, which are not
the first use case. The tools in §3 already answer "what's open/due now".

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

## 7. Phasing

| Phase | Delivers | Size |
|---|---|---|
| 1 | `/mcp` (stateless), tool registry with per-tool scopes + guard test, read + write tools, integration tests over real HTTP (testcontainer PG). Testable with an existing API key in Claude Code (`x-api-key` or `Authorization: Bearer waffled_…` against `/mcp`) — the endpoint, registry and key path are built; the tools are next. | ~1–2 weeks |
| 2 | OAuth 2.1 authorization server on the existing login: metadata, DCR, `/oauth/authorize` web route + consent, token endpoint, `oauth_grants`, scoped-principal gate, Settings → Connected apps. Works as a claude.ai connector. | ~2 weeks |
| — | Safety items (§5) land with the phase that introduces the thing they guard. | — |

**Docs that ship with it** (same PR): a how-to "Connect Claude to Waffled" (public-HTTPS
requirement, consent, revoking), the features reference, and moving this item to *Done*
in `roadmap.md`.
