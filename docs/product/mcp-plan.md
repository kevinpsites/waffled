# MCP server — let an AI agent query and act on a household

**Status:** in progress — §2 (the endpoint), §3 (the tools) and the §5 audit trail are
built, with API-key auth; §4 sign-in is next. **Written:** 2026-11-13.
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
  run: (tenant, args) => choresTarget.applyMutation(ctxFor(tenant), { verb: 'complete', ...args }),
})
```

**Composite reads** (`get_today`) declare `family:read` and include each section only when
the caller also holds that section's scope, so a read never widens what a grant covers.

A guard test walks the tool registry and fails on any tool whose `scope` is not a real
`API_SCOPES` string (fail-closed, same idea as the route-table test in
`api-keys.integration.test.ts`). `tools/list` and `tools/call` share one predicate
(`denialFor` in `modules/mcp/registry.ts`): a tool the caller's scopes don't cover, or whose
`module` is off for the household, is hidden from the list and refused on call.

**What `run` gets and returns.** `run(tenant, args, ctx)`: `ctx` carries the caller's
scopes, the household settings and timezone. It returns `{ data, summary, createdId? }`;
`tools/call` sends `data` as `structuredContent` and its JSON as the first text block (the
spec asks for both), plus the one-line `summary`. Lists are capped (`{ items, total,
truncated }`, and the summary says when it cut). Arguments are checked by hand in
`modules/mcp/args.ts`; any 4xx a service throws becomes an `isError` result.

**Read tools** (`readOnlyHint: true`):

| Tool | Scope | Module | Reuses |
|---|---|---|---|
| `whoami` | `family:read` | — | `getContext` |
| `get_today` | `family:read` + each section's own | per section | the reads below |
| `list_events(from, to)` | `calendar:read` | — | `rangeEvents` (viewer visibility), ≤ 62 days |
| `list_chores(date?, status?, personId?)` | `chores:read` | chores | `ensureTodayInstances` + `listTodayInstances` |
| `get_grocery_list(week?)` | `lists:read` | lists | `groceryBoard` on `householdWeekStart(For)` |
| `list_lists(listId?)` | `lists:read` | lists | `listLists`, `listItems` |
| `get_meal_plan(week?)` | `meals:read` | meals | `weekEntries` on the household week |
| `list_goals(personId?)` | `goals:read` | goals | `listGoals` + `visibleGoalLists`, `goalDisplay` |
| `get_reward_balances` | `rewards:read` | rewards | `balancesSummary` |
| `list_family` | `family:read` | — | `listPersons` (no account emails) |
| `search_recipes(query, limit?)` | `meals:read` | meals | `listRecipes` ranked by `rankCandidates` |

`get_today`'s sections are events (`calendar:read`), chores (`chores:read`, chores on),
meals (`meals:read`, meals on) and the open grocery count (`lists:read`, lists on); a
section the grant or the household rules out is left out and named in `omitted`.

**Find + action tools.** One scope per tool means one tool per target kind, not one per
verb across kinds. `find_chores`, `find_list_items`, `find_events`, `find_goals` and
`find_rewards` (read scopes) return up to 20 `resolveCandidates` matches with ids and a
confidence. The action tools take that id and call `applyMutation` after re-checking
`supportedVerbs` and `isEnabled`:

| Tool | Scope | Hints |
|---|---|---|
| `complete_chore`, `reassign_chore(personId)` | `chores:write` | |
| `complete_list_item` | `lists:write` | |
| `delete_list_item` | `lists:write` | destructive |
| `reschedule_event(date?, time?)` | `calendar:write` | |
| `delete_event` | `calendar:write` | destructive; result `scope: 'occurrence' \| 'event'` |
| `log_goal(amount? hours? minutes? personId?)` | `goals:write` | |
| `redeem_reward(personId?)` | `rewards:write` | destructive |

The capability checks are the capture targets' own (a kid reassigning a chore to a sibling,
or spending a sibling's stars, is refused). The capture targets now take a `personId` as
well as a spoken name, and the goal target no longer offers goals in a private list the
speaker isn't in.

**Create tools.** Each create path moved out of its route into a service function that
both call, so validation, capability checks and side effects cannot drift:

| Tool | Scope | Module | Service (route) |
|---|---|---|---|
| `add_event` | `calendar:write` | — | `createEventFromInput` (`POST /api/events`) |
| `add_list_item(listId?)` | `lists:write` | lists | `addItemFromInput` (`POST /api/lists/:id/items`); grocery list by default |
| `plan_meal` | `meals:write` | meals | `planMealSlot` (`POST /api/meals/plan`), calendar mirroring included |
| `create_chore` | `chores:write` | chores | `createChoreFromInput` (`POST /api/chores`), `chore.manage` for someone else |

`add_event` reads a time without an offset as household-local. Events still have three
write paths; the tool uses the REST one.

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
- **Attribution without touching every table:** `mcp_audit` (`0107_mcp_audit.sql`) —
  household, person, `api_key_id`, `grant_id` (no FK until grants exist), tool,
  `target_ids`, outcome `ok | error | denied`, error text, time. `tools/call` writes one
  row for every call to a `:write`-scoped tool, including scope, module and capability
  refusals (a 403 is `denied`). `target_ids` keeps only id-shaped arguments plus the
  created row's id, never free text. Reads are not audited. No `source` column on events,
  chores, list items or meal plans.
- **Rate limits** per key or grant on `tools/call`.
- **Prompt injection:** household text (list items, event notes, recipe bodies) reaches
  the agent as data. Every tool description that returns household text says so (a guard
  test checks), the `initialize` instructions repeat it, and tools return structured
  fields, not free-form prose that mixes data and instructions.
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
| 4 | §5 | Rate limits, the secrets-in-output guard test; audit rows carry `grant_id`. | ~2–3 days |
| 5 | §6 A | `whats_new(since)`, filtered through each module's read rules; roadmap item → Done. | ~2–3 days |
