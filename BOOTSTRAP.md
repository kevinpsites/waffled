# Bootstrap — one-time console setup

These are the steps that **cannot** be Terraformed (no public API). Do them once; each
produces secrets that IaC consumes. Drop every secret into your secrets store (1Password /
SOPS / TF Cloud vars) and wire them as Terraform variables + Compose `.env` values — see the
mapping table at the bottom.

Order: **A → B → C** (Auth0 needs the Google + Apple secrets). D (AWS) can run any time.

---

## A. Google Cloud — OAuth client + Calendar API

**Goal:** a Google OAuth client (for login-via-Auth0 *and* the backend's Calendar grant) and
the Calendar API enabled.

1. **Create a project** — <https://console.cloud.google.com> → project picker → New Project →
   name `nook`. Note the **Project ID**.
2. **Enable APIs** — APIs & Services → Library → enable **Google Calendar API**. (Optionally
   **People API** for profile data.)
3. **OAuth consent screen** — APIs & Services → OAuth consent screen:
   - User type: **External**.
   - App name, user support email, developer contact. *(Skip uploading a logo for now — a
     logo triggers the verification review sooner.)*
   - **Scopes:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and
     `.../auth/calendar.events` (Calendar = **sensitive scope**).
   - **Test users:** add your Gmail + Kelly's. (Testing mode allows up to 100 test users with
     no verification.)
   - Save. Leave publishing status on **Testing** for now.
   - ⚠️ **Gotcha:** in *Testing* status, Google refresh tokens **expire after 7 days**. Fine
     for dev. Before you rely on long-lived calendar sync you must publish to *Production*,
     which (with the sensitive Calendar scope) triggers Google's **verification review**
     (can take weeks). Plan to submit for verification well before launch.
4. **Create the OAuth client** — APIs & Services → Credentials → Create Credentials →
   **OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs** — add both:
     - `https://<AUTH0_DOMAIN>/login/callback`  (Auth0 brokers Google sign-in)
     - `https://<NOOK_HOSTNAME>/auth/google/calendar/callback`  (backend's incremental Calendar grant)
   - Create → copy **Client ID** and **Client secret**.

> **Produces:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PROJECT_ID`.
> One client serves both flows. Add more redirect URIs later for new environments.

---

## B. Apple — Sign in with Apple (+ APNs while you're here)

**Prereq:** Apple Developer Program membership ($99/yr). All in <https://developer.apple.com/account> → Certificates, Identifiers & Profiles.

1. **App ID** — Identifiers → + → App IDs → App → bundle id e.g. `com.kevinsites.nook`.
   Enable capabilities **Sign in with Apple** and **Push Notifications**. Register.
2. **Services ID** (this is the OAuth `client_id` Auth0 uses) — Identifiers → + → Services IDs
   → identifier e.g. `com.kevinsites.nook.signin`, description "Kinnook Web". Register, then edit it:
   - Enable **Sign in with Apple** → Configure:
     - Primary App ID: the App ID from step 1.
     - **Domains:** `<AUTH0_DOMAIN>`.
     - **Return URLs:** `https://<AUTH0_DOMAIN>/login/callback`.
   - Save. (Auth0's Apple connection page shows the exact values to paste.)
3. **Sign in with Apple key** — Keys → + → enable **Sign in with Apple** → Configure (primary
   App ID) → Register → **Download the `.p8`** (one-time download!). Note the **Key ID**.
4. **APNs key** (used later for push, but make it now) — Keys → + → enable **Apple Push
   Notifications service (APNs)** → Register → download `.p8`, note **Key ID**.
5. **Team ID** — top-right of the Membership page.

> **Produces (Sign in with Apple):** `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_SERVICES_ID`
> (the Services ID), and the Sign-in `.p8` contents.
> **Produces (APNs, for later):** `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, the APNs `.p8`.

---

## C. Auth0 — tenant + management credentials (rest is Terraform)

**Goal:** a tenant and a machine-to-machine app so the Auth0 Terraform provider can manage
everything else (connections, apps, the `household_id` action, the API/audience).

1. **Create a tenant** — <https://auth0.com> → sign up / create tenant. Pick a region
   (e.g. `us`). Your domain is `<tenant>.<region>.auth0.com` → this is `AUTH0_DOMAIN`.
2. **M2M app for Terraform** — Applications → Create Application → **Machine to Machine** →
   authorize the **Auth0 Management API** → grant the scopes the provider needs (simplest:
   all `read:*`/`create:*`/`update:*`/`delete:*` on clients, connections, resource servers,
   actions, rules). Copy its **Client ID** and **Client Secret**.

> **Produces:** `AUTH0_DOMAIN`, `AUTH0_MGMT_CLIENT_ID`, `AUTH0_MGMT_CLIENT_SECRET`.
> Terraform then creates: the Google connection (consumes `GOOGLE_CLIENT_ID/SECRET`), the
> Apple connection (consumes the Apple secrets), the native-iOS app, the web SPA, the API
> (`audience`), and the action that injects `household_id`.

---

## D. AWS — credentials + Terraform state backend

**Goal:** credentials Terraform can use, plus the remote-state bucket/lock (created by the
`infra/terraform/bootstrap` stack in chunk 1.1).

1. **Identity for Terraform** — an IAM user (or SSO role) with admin-ish rights for the
   resources we manage (S3, CloudFront, IAM, ACM). Configure an AWS CLI profile `nook`.
2. **State backend** — run the bootstrap Terraform stack once to create the encrypted state
   S3 bucket + DynamoDB lock table. (Documented in `infra/terraform/bootstrap/README.md`.)

> **Produces:** `AWS_PROFILE`/keys, `AWS_REGION`, `TF_STATE_BUCKET`, `TF_LOCK_TABLE`.
> The nightly-backup IAM key is **created by Terraform** (chunk 1.2) and output for `.env`.

---

## Secret → destination mapping

| Secret | Source | Used by |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google (A) | Auth0 Google connection (TF) + `api` calendar OAuth (`.env`) |
| `GOOGLE_PROJECT_ID` | Google (A) | optional GCP Terraform |
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_SERVICES_ID` + sign-in `.p8` | Apple (B) | Auth0 Apple connection (TF) |
| `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_BUNDLE_ID` + APNs `.p8` | Apple (B) | `worker` push (`.env`, later) |
| `AUTH0_DOMAIN` / `AUTH0_MGMT_CLIENT_ID` / `AUTH0_MGMT_CLIENT_SECRET` | Auth0 (C) | Auth0 Terraform provider |
| `AWS_*` / `TF_STATE_BUCKET` / `TF_LOCK_TABLE` | AWS (D) | Terraform backend + providers |
| `NOOK_HOSTNAME` | your tailnet MagicDNS name | Compose (Caddy, api) + TF (Auth0 callbacks) |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` | `api`/`worker` — encrypts Google refresh tokens at rest |

## After bootstrap

A fresh environment is then: paste these secrets into your secrets store →
`terraform apply` (AWS + Auth0) → `docker compose up`. No further console trips unless you
add a brand-new redirect URI or submit for Google/Apple production verification.
