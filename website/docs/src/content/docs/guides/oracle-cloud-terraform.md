---
title: Deploy to Oracle Cloud (free) with Terraform
description: Run the whole Waffled stack on Oracle Cloud's Always Free tier, provisioned by Terraform, with automatic HTTPS.
---

Waffled is designed to live on one always-on machine. If you don't have a spare mini-PC or Pi,
**Oracle Cloud's Always Free tier** gives you a genuinely free, always-on Arm server that's big
enough to run the whole stack — and this repo ships a **Terraform module** that stands the whole
thing up for you: network, server, Docker, the app, and automatic HTTPS.

The module lives at [`infra/terraform/oci`](https://github.com/kevinpsites/waffled/tree/main/infra/terraform/oci).

## What you get

One **Arm Ampere A1** instance running the same `docker compose` stack you'd run locally —
Postgres, PowerSync, the api, Caddy, and the nightly backup. Terraform creates the network and
the instance; a first-boot script installs Docker, clones this repo, generates your secrets, and
brings everything up. When you give it a domain, **Caddy provisions Let's Encrypt certificates
automatically**, and `terraform apply` prints the URL you plug into the app.

### Cost & sizing

**$0/month** on the Always Free tier.

:::caution[The free allowance shrank in 2026]
On **2026-06-15 Oracle cut the free A1 allowance from 4 OCPU / 24 GB to 2 OCPU / 12 GB** for
free-tier accounts. The module defaults to **2 OCPU / 12 GB** — right at the ceiling, and still
comfortably more than the stack needs (~4 GB). Block storage stays 200 GB free; the module uses a
100 GB boot volume. Pay-As-You-Go accounts reportedly still get 4 OCPU / 24 GB free — raise
`instance_ocpus` / `instance_memory_gbs` if that's you.
:::

## What you'll need

- **[Terraform](https://developer.hashicorp.com/terraform/install)** ≥ 1.5 (or OpenTofu) installed
  on your own computer.
- An **[Oracle Cloud account](https://www.oracle.com/cloud/free/)** (the free sign-up needs a card
  for identity verification; the Always Free resources aren't charged).
- A **domain you own** where you can add DNS records — needed for HTTPS, which the iOS app and the
  barcode scanner require.

### You'll create two different keys — don't mix them up

This trips people up, so here's the map up front:

| Key | What it's for | Who makes it | Where it goes |
|---|---|---|---|
| **Oracle API key** | Lets *Terraform* sign in to Oracle | Oracle generates it in the Console; you download a `.pem` file | `private_key_path` in your settings |
| **SSH key** | Lets *you* log into the server later | *You* generate it on your computer with `ssh-keygen` | `ssh_public_key` in your settings |

We make the SSH key first (one command), then get the Oracle key.

## Step 1 — Make your SSH key

On your own computer, run:

```bash
ssh-keygen -t ed25519 -C "waffled" -f ~/.ssh/waffled
```

Press Enter through the prompts (a passphrase is optional). This creates two files: `~/.ssh/waffled`
(private — keep it) and `~/.ssh/waffled.pub` (public — this is what you'll paste). Print the public
one so you can copy it in Step 3:

```bash
cat ~/.ssh/waffled.pub
```

## Step 2 — Get your Oracle API key

This is what lets Terraform talk to Oracle. You'll come away with **five values**.

1. Sign in to the **[Oracle Cloud Console](https://cloud.oracle.com)**.
2. Click your **profile icon** (top-right) → **My profile**.
3. In the left panel under *Resources*, click **API keys** → **Add API key**.
4. Choose **Generate API key pair**, click **Download private key** (save it as, say,
   `~/.oci/oci_api_key.pem`), then click **Add**.
5. Oracle shows a **Configuration file preview** — leave it open. Four of your five values are
   right there:

   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..aaaa...        # → user_ocid
   fingerprint=aa:bb:cc:...            # → fingerprint
   tenancy=ocid1.tenancy.oc1..aaaa...  # → tenancy_ocid
   region=us-ashburn-1                 # → region
   ```

   The fifth, `private_key_path`, is wherever you just saved the `.pem` file.

Then lock down that file so only you can read it:

```bash
chmod 600 ~/.oci/oci_api_key.pem
```

## Step 3 — Fill in your settings

Grab the module and make your settings file:

```bash
git clone https://github.com/kevinpsites/waffled.git
cd waffled/infra/terraform/oci
cp terraform.tfvars.example terraform.tfvars
```

Open `terraform.tfvars` and fill it in — the five Oracle values from Step 2, the SSH **public** key
you printed in Step 1, your domain, and any API keys you use (all optional):

```hcl
# From Step 2 (Oracle API key)
tenancy_ocid     = "ocid1.tenancy.oc1..aaaa..."
user_ocid        = "ocid1.user.oc1..aaaa..."
fingerprint      = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
private_key_path = "~/.oci/oci_api_key.pem"
region           = "us-ashburn-1"

# From Step 1 (paste the output of `cat ~/.ssh/waffled.pub`)
ssh_public_key   = "ssh-ed25519 AAAA... waffled"

# Your domain
domain           = "waffled.example.com"

# API keys — leave blank for anything you don't use
anthropic_api_key = "sk-ant-..."
```

`terraform.tfvars` is **gitignored**, so your keys never get committed to the repo. (More on
secrets [below](#about-your-api-keys-and-secrets).)

## Step 4 — Apply

```bash
terraform init
terraform apply
```

Review the plan, type `yes`, and Terraform creates the network and the instance. On success it
prints the outputs:

```
app_url            = "https://waffled.example.com"
public_ip          = "140.238.x.x"
dns_records_needed = [
  "waffled.example.com            A  140.238.x.x",
  "powersync.waffled.example.com  A  140.238.x.x",
]
```

:::caution["Out of host capacity"]
Free A1 capacity is in high demand, so `apply` sometimes fails with **`Out of host capacity`**.
Try a different `availability_domain_number` (1, 2, 3), a different `region`, or just re-run
`apply` until it lands. Upgrading the account to **Pay-As-You-Go** (still free for these
resources) dramatically improves availability and stops idle accounts from being reclaimed.
:::

## Step 5 — Point DNS at it, then wait for HTTPS

Create the two **A records** from the `dns_records_needed` output at your DNS provider, both
pointing at `public_ip`:

| Record | Type | Value |
|---|---|---|
| `waffled.example.com` | A | *your public IP* |
| `powersync.waffled.example.com` | A | *your public IP* |

The `powersync.` record gives the offline-sync service its own hostname and certificate, so sync
runs over HTTPS/WSS — without it the iOS app and kiosk can't sync from a secure page.

The instance needs a few minutes on first boot to pull images and start the stack; then Caddy
requests certificates (this needs the DNS records live and ports 80/443 open — both handled).
Once DNS has propagated, open **`https://waffled.example.com`**, complete the
[first-run wizard](/install/docker/#first-run), and **that URL is what you enter in the app**.

## Watching the first boot / troubleshooting

Bootstrapping runs unattended, but you can watch it over SSH:

```bash
ssh ubuntu@<public_ip>
sudo tail -f /var/log/waffled-bootstrap.log   # the deploy script
cd /opt/waffled && sudo docker compose ps      # container health
sudo docker compose logs caddy                 # TLS / ACME progress
```

- **Site unreachable although the instance is up** — Oracle's Ubuntu image ships a restrictive
  host firewall; the boot script opens 80/443 in it, but verify with `sudo iptables -L INPUT -n`.
- **Certificate not issuing** — confirm both DNS records resolve to the public IP and that ports
  80/443 are reachable; `docker compose logs caddy` shows the ACME handshake.

## About your API keys and secrets

Your API keys ride along automatically — just fill in the ones you use in `terraform.tfvars` and
Terraform writes them into the server's config on first boot. There's a named slot for each of the
common ones (blank is fine for anything you don't use):

```hcl
anthropic_api_key    = "sk-ant-..."   # hosted Claude for the AI capture bar
openai_api_key       = ""             # or OpenAI instead
google_client_id     = ""             # Google Calendar sync
google_client_secret = ""
```

Anything not listed goes in the `app_env` map (e.g. offsite S3 backups):

```hcl
app_env = {
  BACKUP_S3_BUCKET = "s3://my-bucket/waffled"
}
```

**Where do these live? Are they safe?** Both the file you type them in (`terraform.tfvars`) and
Terraform's state file are **gitignored**, so your keys are never committed to the repo — they stay
on your own computer. Marking the variables *sensitive* also keeps their values out of `terraform`
command output. The one thing to know: Terraform stores them in **plaintext inside its local state
file**, so treat that file as private (don't share it or put it somewhere public). If you later move
to a *shared/remote* state backend, turn on its encryption. For a solo home deploy, the defaults are
fine as-is.

:::tip[Keep secrets stable across a rebuild]
`LOCAL_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `POSTGRES_PASSWORD` are generated fresh on each boot.
If you ever recreate the instance and want to *avoid* signing everyone out (and keep stored Google
tokens readable), set those three in `app_env` so they stay constant.
:::

See the full list of settings in the [Environment variables](/install/environment-variables/)
reference. Prefer not to put a particular key in Terraform at all? You can always SSH in, edit
`/opt/waffled/infra/compose/.env`, and run `sudo waffled-oci up`.

## Upgrading

Upgrades happen **on the server, not through Terraform.** Cloud-init only runs once, so
re-running `terraform apply` won't upgrade the app — and bumping the version in Terraform can
make it try to *replace* the instance, which would wipe your data. Think of it as two tools,
two jobs: **Terraform owns the box; the app version is a day-2, on-box concern.**

The bootstrap installs a helper for exactly this:

```bash
ssh ubuntu@<public_ip>
sudo waffled-oci upgrade
```

`waffled-oci upgrade` does the same thing as [`./waffled upgrade`](/operations/upgrading/) —
`git pull`, a pre-upgrade database backup, pull the new images, run migrations — but it always
includes this deployment's HTTPS override, so **your TLS setup survives the upgrade** (the stock
`./waffled upgrade` would drop the port-443 config). It also handles `up`, `down`, `restart`,
`logs`, and `status`; any other subcommand falls through to the real `./waffled` CLI, so
`sudo waffled-oci backup` and `sudo waffled-oci doctor` work too.

## Day 2

- **Your data lives in Docker named volumes** (`pgdata`, `waffled_media`, backups) on the boot
  volume — it survives reboots and upgrades. **Never** run `docker compose down -v`. For real
  durability, set the `BACKUP_S3_*` variables (in `app_env` or the box's `.env`) to push nightly
  dumps offsite — see [Offsite backups](/guides/offsite-backups/).
- **`terraform destroy` deletes everything, including the volumes.** Back up first.

## HTTP-only (quick test)

Leave `domain` empty and the module serves plain HTTP on `http://<public_ip>` with no TLS. The
web UI works, but the **iOS app and barcode scanner require HTTPS**, so use this only for a quick
browser smoke-test — set a `domain` for anything real.

## Prefer somewhere else?

This same single-VM-plus-Compose shape runs anywhere. Oracle is the only $0 option, but
[Hetzner Cloud](https://www.hetzner.com/cloud) runs the identical 4 GB spec for a few dollars a
month with far simpler capacity and setup — a good alternative if the free-tier constraints chafe.
