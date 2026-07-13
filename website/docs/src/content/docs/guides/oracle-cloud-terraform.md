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

## Prerequisites

- **[Terraform](https://developer.hashicorp.com/terraform/install)** ≥ 1.5 (or OpenTofu) on your
  own machine.
- An **[Oracle Cloud account](https://www.oracle.com/cloud/free/)** (the free sign-up needs a card
  for identity verification; the Always Free resources aren't charged).
- A **domain you control** and can add DNS records to — needed for HTTPS (and HTTPS is required
  for the iOS app and the barcode scanner to work).
- An **SSH key pair** (`ssh-keygen -t ed25519` if you don't have one).

## Step 1 — Get your Oracle Cloud credentials for Terraform

Terraform talks to Oracle with an **API signing key** — a key pair you generate, where Oracle
keeps the public half and you keep the private half. You'll come away with **five values**:
`tenancy_ocid`, `user_ocid`, `fingerprint`, `private_key_path`, and `region`.

1. Sign in to the **[OCI Console](https://cloud.oracle.com)**.
2. Open the **profile menu** (top-right avatar) → **My profile**.
3. In the left panel under *Resources*, click **API keys** → **Add API key**.
4. Choose **Generate API key pair**, click **Download private key** (save it somewhere safe, e.g.
   `~/.oci/oci_api_key.pem`), then **Add**.
5. Oracle now shows a **Configuration file preview**. Leave it open — it contains four of your five
   values:

   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..aaaa...        # → user_ocid
   fingerprint=aa:bb:cc:...            # → fingerprint
   tenancy=ocid1.tenancy.oc1..aaaa...  # → tenancy_ocid
   region=us-ashburn-1                 # → region
   key_file=<path to your private key> # → private_key_path (the file you just downloaded)
   ```

   Copy `user`, `fingerprint`, `tenancy`, and `region`. The fifth value, `private_key_path`, is
   wherever you saved the downloaded `.pem`.

:::tip[Lock down the private key]
`chmod 600 ~/.oci/oci_api_key.pem`. Anyone with this file can act as your Oracle user.
:::

## Step 2 — Configure Terraform

```bash
git clone https://github.com/kevinpsites/waffled.git
cd waffled/infra/terraform/oci
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with the five credential values, your SSH **public** key, and your domain:

```hcl
# From Step 1
tenancy_ocid     = "ocid1.tenancy.oc1..aaaa..."
user_ocid        = "ocid1.user.oc1..aaaa..."
fingerprint      = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
private_key_path = "~/.oci/oci_api_key.pem"
region           = "us-ashburn-1"

# Access
ssh_public_key   = "ssh-ed25519 AAAA... you@host"   # cat ~/.ssh/id_ed25519.pub
allowed_ssh_cidr = "203.0.113.7/32"                 # your IP; omit to allow any

# Public HTTPS + hostname (recommended)
domain           = "waffled.example.com"
```

`terraform.tfvars` is gitignored — it holds your identifiers, so it stays out of version control.

## Step 3 — Apply

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

## Step 4 — Point DNS at it, then wait for HTTPS

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

## Day 2

The server is a normal Compose stack under `/opt/waffled`, so the whole
[`./waffled` CLI](/install/docker/#the-waffled-cli) works on the box:

```bash
cd /opt/waffled
sudo ./waffled status     # health table
sudo ./waffled backup     # run a backup now
sudo ./waffled upgrade    # pull the latest release
```

- **Your data lives in Docker named volumes** (`pgdata`, `waffled_media`, backups) on the boot
  volume. **Never** run `docker compose down -v`. For real durability, set the `BACKUP_S3_*`
  variables in `/opt/waffled/infra/compose/.env` to push nightly dumps offsite — see
  [Offsite backups](/guides/offsite-backups/).
- **`terraform destroy` deletes everything, including the volumes.** Back up first.

## HTTP-only (quick test)

Leave `domain` empty and the module serves plain HTTP on `http://<public_ip>` with no TLS. The
web UI works, but the **iOS app and barcode scanner require HTTPS**, so use this only for a quick
browser smoke-test — set a `domain` for anything real.

## Prefer somewhere else?

This same single-VM-plus-Compose shape runs anywhere. Oracle is the only $0 option, but
[Hetzner Cloud](https://www.hetzner.com/cloud) runs the identical 4 GB spec for a few dollars a
month with far simpler capacity and setup — a good alternative if the free-tier constraints chafe.
