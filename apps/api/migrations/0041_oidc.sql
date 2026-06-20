-- OIDC (backend-mediated, Immich-style): config lives in the DB and is edited by
-- an admin in Settings — the operator attaches their IdP after first-run setup and
-- chooses whether password login stays on. The auth-code + PKCE flow runs
-- server-side and ends at the same mintAccess/issueRefresh as password login, so
-- everything downstream (sub→identity→person→household) is unchanged.

-- Singleton config row (id is fixed true so there's exactly one).
create table if not exists auth_config (
  id                     boolean primary key default true,
  oidc_enabled           boolean not null default false,
  issuer_url             text,
  client_id              text,
  client_secret_enc      text,                 -- AES-GCM at rest (crypto.ts); never returned to clients
  scopes                 text not null default 'openid email profile',
  button_label           text not null default 'Sign in with SSO',
  password_login_enabled boolean not null default true,
  updated_at             timestamptz not null default now(),
  constraint auth_config_singleton check (id)
);
insert into auth_config (id) values (true) on conflict (id) do nothing;

-- One-time login states for the OIDC redirect dance (state + PKCE verifier + nonce).
create table if not exists oidc_login_states (
  state         text primary key,
  code_verifier text not null,
  nonce         text not null,
  redirect_to   text,
  created_at    timestamptz not null default now()
);

-- One-time handoff: the callback mints a session and stashes the principal here,
-- then redirects with just an opaque code — so access/refresh tokens never ride the
-- redirect URL (browser history / referrer / logs). The SPA exchanges it for tokens.
create table if not exists auth_handoffs (
  code        text primary key,
  person_id   uuid not null references persons(id),
  subject     text not null,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);
