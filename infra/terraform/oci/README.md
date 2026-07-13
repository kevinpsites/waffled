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
2. **An API signing key** for Terraform:
   - Console → **Profile → My profile → API keys → Add API key** → *Generate a key pair*
     → download the **private key** (save it to e.g. `~/.oci/oci_api_key.pem`).
   - After adding it, Oracle shows a **configuration file preview** with your
     `tenancy`, `user`, `fingerprint`, and `region` OCIDs — copy those.
3. **An SSH key pair** (`ssh-keygen -t ed25519`) — you'll paste the **public** key.
4. **(HTTPS)** A **domain** you control, where you can add DNS `A` records.

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

1. Create the two DNS **A records** from the `dns_records_needed` output, both pointing
   at `public_ip`:
   ```
   waffled.example.com            A  <public_ip>
   powersync.waffled.example.com  A  <public_ip>
   ```
   (The `powersync.` record lets offline-sync run over HTTPS/WSS too — its port isn't
   behind Caddy in the stock config, so this module gives it its own hostname + cert.)
2. Wait a few minutes. Cloud-init pulls images and starts the stack, then **Caddy
   fetches Let's Encrypt certificates** (needs the DNS records live + ports 80/443 open,
   both of which this module handles).
3. Open `https://waffled.example.com`, finish the first-run wizard, and **that URL is
   what you plug into the app**.

### If you leave `domain` empty (HTTP smoke-test only)

Open `http://<public_ip>`. The web UI works, but the **iOS app and the barcode scanner
require HTTPS** (secure-context / App Transport Security), so use this only for a quick
browser check — set a `domain` for real use.

## Watching / troubleshooting the first boot

Bootstrapping takes a few minutes (image pulls). To watch it:

```bash
ssh ubuntu@<public_ip>
sudo tail -f /var/log/waffled-bootstrap.log   # this module's script
sudo tail -f /var/log/cloud-init-output.log   # cloud-init overall
cd /opt/waffled && sudo docker compose ps      # container health
```

- **`Out of host capacity` on apply** — the classic free-tier A1 pain. Try a different
  `availability_domain_number` (1/2/3), a different `region`, or re-run `apply` on a
  loop until capacity frees. A **Pay-As-You-Go** account largely fixes this.
- **Site unreachable but instance is up** — OCI's Ubuntu image ships a restrictive host
  iptables firewall; the bootstrap opens 80/443 (and 8090 in HTTP mode) in it. Confirm
  with `sudo iptables -L INPUT -n`. The cloud Security List is managed by Terraform.
- **TLS not issuing** — check both DNS records resolve to `public_ip` and that 80/443
  are reachable; `sudo docker compose logs caddy` shows ACME progress.

## Day 2

- The app is a normal Compose stack under `/opt/waffled`. Use the `./waffled` CLI on the
  box (`sudo ./waffled status|logs|backup|upgrade|doctor`).
- **Data lives in Docker named volumes** (`pgdata`, `waffled_media`, backups) on the
  boot volume — **never** `docker compose down -v`. Configure offsite S3 backups via the
  `BACKUP_S3_*` vars in `/opt/waffled/infra/compose/.env` for real durability.
- `terraform destroy` tears everything down **including the volumes** — back up first.

## What this does *not* do

- No reserved/static public IP resource — it uses the instance's ephemeral public IP,
  which is stable for the instance's life but changes if you *terminate* it. For a
  permanently fixed IP, add an `oci_core_public_ip` (RESERVED) and update DNS.
- No managed DNS — bring your own registrar/DNS. (You could add an `oci_dns_*` zone.)
- No remote Terraform state — state is local. Use an OCI Object Storage backend if you
  want it shared/durable.
