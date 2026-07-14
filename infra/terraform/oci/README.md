# Deploy Waffled to Oracle Cloud (Always Free) with Terraform

This module stands up the **entire Waffled stack** — Postgres, PowerSync, api, Caddy,
and the nightly backup — on a single **Arm Ampere A1** instance in Oracle Cloud's
**Always Free** tier, and (optionally) fronts it with **automatic HTTPS**. It runs the
same `infra/compose/docker-compose.yml` you'd run locally; there's no separate build.

Terraform creates: a VCN + public subnet + internet gateway + security list, and the
A1 instance. Cloud-init on the instance installs Docker, clones this repo, writes an
`.env` (with freshly generated secrets), and brings the stack up.

## Cost

**$0/month** on the Always Free tier. Heads-up: on **2026-06-15 Oracle cut the free A1
allowance from 4 OCPU / 24 GB to 2 OCPU / 12 GB** for free-tier accounts. This module
defaults to **2 OCPU / 12 GB** — right at the ceiling, and still comfortably more than
the stack needs (~4 GB). Block storage is 200 GB free; we use a 100 GB boot volume.

> If you're on a **Pay-As-You-Go** account you may still get 4 OCPU / 24 GB for free —
> bump `instance_ocpus` / `instance_memory_gbs` if so. PAYG also gets far better A1
> capacity (see the capacity note below) and won't be reclaimed for idleness.

## Prerequisites

1. **Terraform** ≥ 1.5 and an **Oracle Cloud account**.
2. **(HTTPS)** A **domain** you own, where you can add DNS `A` records.

You'll deal with **two different keys** — don't mix them up:

| Key | For | Made by | Goes in |
|---|---|---|---|
| **Oracle API key** | Terraform signing in to Oracle | Oracle (Console generates it; you download a `.pem`) | `private_key_path` |
| **SSH key** | You logging into the server | You: `ssh-keygen -t ed25519 -f ~/.ssh/waffled` | `ssh_public_key` (paste `~/.ssh/waffled.pub`) |

**Oracle API key:** Console → profile icon → **My profile → API keys → Add API key** →
*Generate API key pair* → **Download private key** (e.g. `~/.oci/oci_api_key.pem`) → **Add**.
Oracle then shows a **Configuration file preview** with your `tenancy`, `user`, `fingerprint`,
and `region` — copy those four. Lock the file down: `chmod 600 ~/.oci/oci_api_key.pem`.

The full field-by-field walkthrough (with commands) is in the
[Deploy to Oracle Cloud guide](https://docs.waffled.app/guides/oracle-cloud-terraform/).

## Usage

```bash
cd infra/terraform/oci
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars with your OCIDs, key paths, ssh_public_key, and domain

terraform init
terraform apply
```

`apply` prints the instance's `public_ip` and the exact DNS records to create.

### If you set a `domain` (HTTPS — recommended)

1. Create the DNS **A record(s)** from the `dns_records_needed` output, pointing at
   `public_ip`. By default that's two records — the app and a `powersync.` subdomain for
   offline-sync (its port isn't behind Caddy in the stock config, so it gets its own
   hostname + cert):
   ```
   waffled.example.com            A  <public_ip>
   powersync.waffled.example.com  A  <public_ip>
   ```

   **Can't add a second-level subdomain?** (Some DNS hosts won't.) Set `powersync_port = 8443`
   and PowerSync is served on your **same domain, a different port** — `dns_records_needed`
   then lists just the one record, and clients use `https://<domain>:8443`. Or set
   `powersync_host = "sync.example.com"` to use any hostname you *can* create a record for.
2. Wait a few minutes. Cloud-init pulls images and starts the stack, then **Caddy
   fetches Let's Encrypt certificates** (needs the DNS records live + the ports open, both
   of which this module handles).
3. Open `https://waffled.example.com`, finish the first-run wizard, and **that URL is
   what you plug into the app**.

### If you leave `domain` empty (HTTP smoke-test only)

Open `http://<public_ip>`. The web UI works, but the **iOS app and the barcode scanner
require HTTPS** (secure-context / App Transport Security), so use this only for a quick
browser check — set a `domain` for real use.

## Watching / troubleshooting the first boot

Bootstrapping takes a few minutes (image pulls). To watch it:

```bash
ssh -i ~/.ssh/waffled ubuntu@<public_ip>   # or copy the `ssh_command` output
sudo tail -f /var/log/waffled-bootstrap.log   # this module's script
sudo tail -f /var/log/cloud-init-output.log   # cloud-init overall
cd /opt/waffled && sudo docker compose ps      # container health
```

- **"Server is down" from Cloudflare** — your DNS records are *Proxied* (orange cloud).
  Cloudflare then intercepts 80/443 so Caddy can't issue/serve certs. Set both records to
  **DNS only** (grey cloud). Port-mode PowerSync also needs grey cloud (CF only proxies
  standard ports).
- **SSH `Permission denied (publickey)`** — the connection worked (port 22 is open); `ssh`
  just didn't offer the right key. Use `ssh -i <your_private_key> ubuntu@<public_ip>` and
  confirm your `.pub` matches the `ssh_public_key` in `terraform.tfvars`.
- **`Out of host capacity` on apply** — the classic free-tier A1 pain. Try a different
  `availability_domain_number` (1/2/3), a different `region`, or re-run `apply` on a
  loop until capacity frees. A **Pay-As-You-Go** account largely fixes this.
- **Site unreachable but instance is up** — OCI's Ubuntu image ships a restrictive host
  iptables firewall; the bootstrap opens 80/443 (and 8090 in HTTP mode) in it. Confirm
  with `sudo iptables -L INPUT -n`. The cloud Security List is managed by Terraform.
- **TLS not issuing** — check both DNS records resolve to `public_ip` (grey cloud on
  Cloudflare) and that 80/443 are reachable; `sudo docker compose logs caddy` shows ACME.

## App config & secrets (API keys, OAuth)

Your API keys ride along automatically — fill in the named variables in `terraform.tfvars` and
they're written into the server's `.env` at first boot (applied last, so they override the
derived values). Blank is fine for anything you don't use:

```hcl
anthropic_api_key    = "sk-ant-..."   # hosted Claude for the AI capture bar
openai_api_key       = ""             # or OpenAI instead
google_client_id     = ""             # Google Calendar sync
google_client_secret = ""
```

Anything not named gets an `app_env` map (backups to S3, Ollama, …):

```hcl
app_env = { BACKUP_S3_BUCKET = "s3://my-bucket/waffled" }
```

**On safety:** both `terraform.tfvars` and the state file are **gitignored** — nothing here is
committed to the repo, it stays on your machine. The variables are marked `sensitive`, so their
values don't show in `terraform` output either. The only caveat is the ordinary Terraform one:
the local **state file holds them in plaintext**, so keep that file private; if you ever adopt a
remote state backend, enable its encryption. Values must be single-line (base64-encode multi-line
secrets like PEM keys). Prefer to keep a key out of Terraform entirely? SSH in, edit
`/opt/waffled/infra/compose/.env`, and run `sudo waffled-oci up`.

Tip: pin `LOCAL_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` in `app_env` if you
want them to survive an instance rebuild — otherwise they regenerate on each fresh boot, which
signs everyone out and makes stored OAuth tokens unreadable.

## Upgrading

Upgrades happen **on the server**, not through Terraform — cloud-init only runs once, so
re-`apply`ing won't upgrade the app (and changing the version could try to *replace* the
instance and wipe your data). Use the installed helper:

```bash
ssh ubuntu@<public_ip>
sudo waffled-oci upgrade    # git pull + pre-upgrade backup + pull images + migrate
```

`waffled-oci` is a thin wrapper around the same steps as the stock `./waffled`, but it always
includes this deployment's `docker-compose.oci.yml` override, so **upgrades keep the HTTPS/443
config** (the plain `./waffled upgrade` would drop it). It also supports
`up | down | restart | logs | status`; anything else falls through to the real `./waffled` CLI
(`sudo waffled-oci backup`, `sudo waffled-oci doctor`, …).

> Terraform is for the **infrastructure** (create / resize / destroy the box). The app version
> is a **day-2, on-box** concern. Two tools, two jobs.

## Day 2

- **Data lives in Docker named volumes** (`pgdata`, `waffled_media`, backups) on the boot
  volume — it survives reboots and upgrades. **Never** `docker compose down -v`. Configure
  offsite S3 backups via the `BACKUP_S3_*` vars (in `app_env` or `.env`) for real durability.
- `terraform destroy` tears everything down **including the volumes** — back up first.

## What this does *not* do

- No reserved/static public IP resource — it uses the instance's ephemeral public IP,
  which is stable for the instance's life but changes if you *terminate* it. For a
  permanently fixed IP, add an `oci_core_public_ip` (RESERVED) and update DNS.
- No managed DNS — bring your own registrar/DNS. (You could add an `oci_dns_*` zone.)
- No remote Terraform state — state is local. Use an OCI Object Storage backend if you
  want it shared/durable.
