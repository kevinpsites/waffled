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

# ── App config (all optional — leave blank for anything you don't use) ────────
# These are written into the server's .env at first boot. The app treats every one
# as optional, so empty is fine. They're marked `sensitive` (hidden from Terraform
# output); your terraform.tfvars and state file are gitignored, so nothing here is
# ever committed — just keep your local state file to yourself.

# AI capture bar — hosted Claude (recommended). Leave blank to use the on-device
# heuristic instead.
variable "anthropic_api_key" {
  description = "Anthropic API key for the AI capture bar. Blank = off."
  type        = string
  default     = ""
  sensitive   = true
}

variable "anthropic_model" {
  description = "Optional Anthropic model override, e.g. claude-haiku-4-5-20251001."
  type        = string
  default     = ""
}

# AI capture bar — hosted OpenAI (alternative to Claude).
variable "openai_api_key" {
  description = "OpenAI API key for the AI capture bar. Blank = off."
  type        = string
  default     = ""
  sensitive   = true
}

variable "openai_model" {
  description = "Optional OpenAI model override, e.g. gpt-4o-mini."
  type        = string
  default     = ""
}

# Google Calendar 2-way sync (optional). Register a Web application OAuth client in
# the Google Cloud Console; set its redirect URI to
# https://<your-domain>/auth/google/calendar/callback.
variable "google_client_id" {
  description = "Google OAuth client ID for calendar sync. Blank = off."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret for calendar sync."
  type        = string
  default     = ""
  sensitive   = true
}

# Escape hatch for anything not listed above (backups to S3, Ollama, etc.). Same
# rules: written into the server's .env, and wins over the values above.
variable "app_env" {
  description = "Any other .env entries as a KEY = VALUE map (advanced)."
  type        = map(string)
  default     = {}
  sensitive   = true
}
