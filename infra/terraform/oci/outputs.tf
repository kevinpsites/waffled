output "public_ip" {
  description = "Public IP of the instance. Point your DNS A record(s) here."
  value       = oci_core_instance.waffled.public_ip
}

output "app_url" {
  description = "The URL to open (and to plug into the app once DNS + TLS settle)."
  value       = var.domain != "" ? "https://${var.domain}" : "http://${oci_core_instance.waffled.public_ip}"
}

output "powersync_url" {
  description = "Offline-sync endpoint clients use (returned by the api to the app)."
  value       = var.domain != "" ? local.powersync_public_url : "http://${oci_core_instance.waffled.public_ip}:8090"
}

output "dns_records_needed" {
  description = "DNS records to create (HTTPS mode) so auto-TLS can succeed."
  # Port mode reuses the single domain record (PowerSync rides <domain>:<port>).
  # Subdomain (default) and custom-host modes need a second record for PowerSync.
  value = local.powersync_mode == "http" ? [] : (
    local.powersync_mode == "port" ? [
      "${var.domain}  A  ${oci_core_instance.waffled.public_ip}",
      ] : [
      "${var.domain}          A  ${oci_core_instance.waffled.public_ip}",
      "${local.powersync_site}  A  ${oci_core_instance.waffled.public_ip}",
    ]
  )
}

output "ssh_command" {
  description = "SSH in (e.g. to tail /var/log/waffled-bootstrap.log)."
  value       = "ssh -i ${var.ssh_private_key_path} ubuntu@${oci_core_instance.waffled.public_ip}"
}
