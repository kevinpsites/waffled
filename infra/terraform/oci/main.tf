locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid

  # User-supplied .env entries, rendered as KEY=VALUE lines and base64-encoded so
  # arbitrary values survive the trip through cloud-init user_data intact.
  app_env_lines = join("\n", [for k, v in var.app_env : "${k}=${v}"])
  app_env_b64   = length(var.app_env) > 0 ? base64encode(local.app_env_lines) : ""

  # Ports open to the world. PowerSync (8090) is only exposed directly in HTTP-only
  # mode; with a domain, Caddy fronts it on powersync.<domain> over TLS instead.
  ingress_ports = concat(
    [
      { port = 22, cidr = var.allowed_ssh_cidr },
      { port = 80, cidr = "0.0.0.0/0" },
      { port = 443, cidr = "0.0.0.0/0" },
    ],
    var.domain == "" ? [{ port = 8090, cidr = "0.0.0.0/0" }] : []
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
      repo_url        = var.waffled_repo_url
      ref             = var.waffled_ref
      waffled_version = var.waffled_version
      domain          = var.domain
      app_env_b64     = local.app_env_b64
    }))
  }
}
