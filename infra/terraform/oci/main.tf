locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid

  # The named app-config variables, as .env keys. The free-form app_env map is
  # merged on top (so it wins) for anything not named here.
  named_env = {
    ANTHROPIC_API_KEY    = var.anthropic_api_key
    ANTHROPIC_MODEL      = var.anthropic_model
    OPENAI_API_KEY       = var.openai_api_key
    OPENAI_MODEL         = var.openai_model
    GOOGLE_CLIENT_ID     = var.google_client_id
    GOOGLE_CLIENT_SECRET = var.google_client_secret
  }
  # Drop blanks (the app already defaults them), merge in app_env, then render as
  # KEY=VALUE lines and base64-encode so values survive cloud-init user_data intact.
  merged_env    = merge({ for k, v in local.named_env : k => v if v != "" }, var.app_env)
  app_env_lines = join("\n", [for k, v in local.merged_env : "${k}=${v}"])
  app_env_b64   = length(local.merged_env) > 0 ? base64encode(local.app_env_lines) : ""

  # ── How PowerSync is served over HTTPS (only when domain is set) ──
  # We drive the base stack's own POWERSYNC_CADDY_ADDRESS knob (Caddy already fronts
  # PowerSync from that env var) rather than shipping a custom Caddyfile.
  #   default    → https://<domain>:8090  (same domain, no extra DNS record — the
  #                stack's own default, derived by ensure_powersync_proxy_env)
  #   host mode  → a dedicated hostname (TLS on 443); needs its own DNS record
  #   port mode  → https://<domain>:<port> (same domain, a different port)
  ps_host_mode = var.domain != "" && var.powersync_host != ""
  ps_port_mode = var.domain != "" && var.powersync_port > 0

  powersync_caddy_address = (
    var.domain == "" ? "" : # HTTP mode: base derives ":8090"
    local.ps_host_mode ? var.powersync_host :
    local.ps_port_mode ? "https://${var.domain}:${var.powersync_port}" :
    "https://${var.domain}:8090"
  )
  powersync_public_url = (
    var.domain == "" ? "" :
    local.ps_host_mode ? "https://${var.powersync_host}" :
    local.ps_port_mode ? "https://${var.domain}:${var.powersync_port}" :
    "https://${var.domain}:8090"
  )
  # Extra Caddy port to publish + open, beyond 80/443. Host mode rides on 443, so none.
  ps_extra_port = (
    var.domain == "" ? "" :
    local.ps_host_mode ? "" :
    local.ps_port_mode ? tostring(var.powersync_port) :
    "8090"
  )
  # Caddy port publishes for the HTTPS override file: 80, 443, + the extra PS port.
  caddy_ports_yaml = join("\n", concat(
    ["      - \"80:80\"", "      - \"443:443\""],
    local.ps_extra_port != "" ? ["      - \"${local.ps_extra_port}:${local.ps_extra_port}\""] : []
  ))

  # Ports open to the world. HTTP mode exposes PowerSync on 8090; HTTPS mode exposes
  # 443 (+ the extra PS port for default/port mode; host mode rides on 443).
  ingress_ports = concat(
    [
      { port = 22, cidr = var.allowed_ssh_cidr },
      { port = 80, cidr = "0.0.0.0/0" },
    ],
    var.domain == "" ? [{ port = 8090, cidr = "0.0.0.0/0" }] : [{ port = 443, cidr = "0.0.0.0/0" }],
    (var.domain != "" && local.ps_extra_port != "") ? [{ port = tonumber(local.ps_extra_port), cidr = "0.0.0.0/0" }] : []
  )
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Most-recent Canonical Ubuntu 24.04 image compatible with the Arm A1 shape.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# ── Network: VCN + IGW + route + security list + public subnet ────────────────
resource "oci_core_vcn" "waffled" {
  compartment_id = local.compartment_id
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "waffled-vcn"
  dns_label      = "waffled"
}

resource "oci_core_internet_gateway" "waffled" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.waffled.id
  display_name   = "waffled-igw"
  enabled        = true
}

resource "oci_core_route_table" "waffled" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.waffled.id
  display_name   = "waffled-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.waffled.id
  }
}

resource "oci_core_security_list" "waffled" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.waffled.id
  display_name   = "waffled-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  dynamic "ingress_security_rules" {
    for_each = local.ingress_ports
    content {
      protocol = "6" # TCP
      source   = ingress_security_rules.value.cidr
      tcp_options {
        min = ingress_security_rules.value.port
        max = ingress_security_rules.value.port
      }
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.waffled.id
  cidr_block        = "10.0.1.0/24"
  display_name      = "waffled-public"
  dns_label         = "public"
  route_table_id    = oci_core_route_table.waffled.id
  security_list_ids = [oci_core_security_list.waffled.id]
}

# ── Compute: Arm A1 instance running the whole Docker Compose stack ───────────
resource "oci_core_instance" "waffled" {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_number - 1].name
  compartment_id      = local.compartment_id
  display_name        = "waffled"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "waffled"
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.sh.tftpl", {
      repo_url                = var.waffled_repo_url
      ref                     = var.waffled_ref
      waffled_version         = var.waffled_version
      domain                  = var.domain
      app_env_b64             = local.app_env_b64
      powersync_public_url    = local.powersync_public_url
      powersync_caddy_address = local.powersync_caddy_address
      ps_extra_port           = local.ps_extra_port
      caddy_ports_yaml        = local.caddy_ports_yaml
    }))
  }

  # Catch the common footgun: most OCI regions (free-tier home regions especially)
  # have exactly ONE availability domain, so availability_domain_number > 1 would
  # index past the list and fail apply with an opaque "index out of range".
  lifecycle {
    precondition {
      condition     = var.availability_domain_number >= 1 && var.availability_domain_number <= length(data.oci_identity_availability_domains.ads.availability_domains)
      error_message = "availability_domain_number is ${var.availability_domain_number}, but ${var.region} has ${length(data.oci_identity_availability_domains.ads.availability_domains)} availability domain(s). Most regions have only 1; ADs 2/3 exist solely in multi-AD regions. If you hit 'Out of host capacity', try a different region instead."
    }
  }
}
