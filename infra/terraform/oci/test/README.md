# Testing the OCI bootstrap

The bootstrap (`../cloud-init.sh.tftpl`) runs unattended on first boot, so a bug in it
(like a missing required secret) surfaces as a dead server. These checks catch that
*before* you provision.

## `config-check.sh` — fast, offline, no image pulls

Reproduces what the bootstrap assembles on the server — the **deployed ref's** compose
files, the `docker-compose.override.yml` the bootstrap writes, and a complete `.env` —
and runs `docker compose config`. That merge:

- fails if the override is malformed, and
- fails if any **required** (`:?`) variable is missing — the exact check that would have
  caught the `POWERSYNC_JWT_PRIVATE_KEY` regression.

It then asserts the HTTPS override landed (443 published, PowerSync's plaintext port closed),
that an `app_env` value is injected, and negatively that **every** required secret is enforced
(discovered from the compose file, so a newly-added one is covered automatically).

```bash
# Requires: docker (daemon running) + git. No network, no Terraform.
infra/terraform/oci/test/config-check.sh            # checks origin/main (what the module deploys)
infra/terraform/oci/test/config-check.sh HEAD       # or any ref/branch/tag
```

Good to wire into CI — it's fast and needs no cloud credentials.

## Full end-to-end

A real bring-up needs to pull the published images, so run it on a machine with registry
access (not a locked-down CI sandbox). Two options:

1. **`terraform apply`** to a throwaway instance, then hit `https://<domain>` and
   `cd /opt/waffled && sudo ./waffled status` (see the [module README](../README.md)). This is the truest test.
2. **Locally**, against a throwaway compose project so it can't clobber a real stack:
   clone the deployed ref, generate a full `.env` (`./waffled up` does this), write the
   override, then bring it up under a unique project name:
   ```bash
   docker compose -p waffled-deploytest \
     -f docker-compose.yml -f docker-compose.override.yml --env-file .env up -d
   docker compose -p waffled-deploytest ps        # wait for healthy
   docker compose -p waffled-deploytest down -v   # clean up (deletes its volumes)
   ```
