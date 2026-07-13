# ── OCI API auth (from Console → Profile → My profile → API keys) ──────────────
variable "tenancy_ocid" {
  description = "OCID of your tenancy (Console → Profile → Tenancy)."
  type        = string
}

variable "user_ocid" {
  description = "OCID of the user whose API key you generated."
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the uploaded API signing key."
  type        = string
}

variable "private_key_path" {
  description = "Path on your machine to the API signing PEM private key."
  type        = string
}

variable "region" {
  description = "OCI region identifier, e.g. us-ashburn-1, uk-london-1, ap-sydney-1."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create resources in. Empty = the root (tenancy) compartment."
  type        = string
  default     = ""
}

# ── Access ────────────────────────────────────────────────────────────────────
variable "ssh_public_key" {
  description = "SSH public key (the contents of e.g. ~/.ssh/id_ed25519.pub) for the `ubuntu` user."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH (port 22). Default is open; set to YOUR_IP/32 to lock it down."
  type        = string
  default     = "0.0.0.0/0"
}

# ── Public HTTPS + hostname ───────────────────────────────────────────────────
# Set `domain` to enable automatic TLS (Let's Encrypt via Caddy). You must point
# BOTH of these DNS records at the instance's public IP AFTER `apply`:
#   <domain>            A   <public_ip>
#   powersync.<domain>  A   <public_ip>     (so offline-sync also runs over HTTPS)
# Leave `domain` empty for a quick HTTP-only test on http://<public_ip> (no TLS;
# the iOS app + barcode scanner need HTTPS, so this is for a browser smoke-test only).
variable "domain" {
  description = "Public hostname for the app (auto-TLS). Empty = HTTP-only on the public IP."
  type        = string
  default     = ""
}

# ── Compute sizing (Always Free ceiling since 2026-06-15 is 2 OCPU / 12 GB) ───
variable "instance_ocpus" {
  description = "Arm OCPUs. Always-Free ceiling is 2 (was 4 before 2026-06-15)."
  type        = number
  default     = 2
}

variable "instance_memory_gbs" {
  description = "RAM in GB. Always-Free ceiling is 12 (was 24 before 2026-06-15)."
  type        = number
  default     = 12
}

variable "boot_volume_gbs" {
  description = "Boot volume size in GB (min 50; Always-Free block storage total is 200)."
  type        = number
  default     = 100
}

variable "availability_domain_number" {
  description = "Which availability domain to launch in (1-based). Try another if you hit 'Out of host capacity'."
  type        = number
  default     = 1
}

# ── App source ────────────────────────────────────────────────────────────────
variable "waffled_repo_url" {
  description = "Git URL the instance clones to run the stack."
  type        = string
  default     = "https://github.com/kevinpsites/waffled.git"
}

variable "waffled_ref" {
  description = "Git branch or tag to check out on the instance."
  type        = string
  default     = "main"
}

variable "waffled_version" {
  description = "Pin WAFFLED_VERSION (published image tag). Empty = whatever .env.example ships."
  type        = string
  default     = ""
}

# ── App config delivered into the server's .env ───────────────────────────────
# Extra KEY = VALUE entries written into infra/compose/.env on the instance —
# e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_CLIENT_ID/SECRET. Applied AFTER
# the generated secrets and networking vars, so anything you set here wins.
#
# ⚠ SECURITY: these values land in Terraform STATE and the instance metadata in
# plaintext. Keep your state file private. For the most sensitive keys you can
# instead leave them out and add them by hand in /opt/waffled/infra/compose/.env.
# Values must be single-line (base64-encode multi-line secrets like PEM keys).
variable "app_env" {
  description = "Extra .env entries (API keys, OAuth, overrides) to deploy onto the server."
  type        = map(string)
  default     = {}
  sensitive   = true
}
