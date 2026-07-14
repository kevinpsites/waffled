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
  # Port mode reuses the one domain record; hostname mode needs a record for the PS host too.
  value = var.domain == "" ? [] : (
    local.ps_port_mode ? [
      "${var.domain}  A  ${oci_core_instance.waffled.public_ip}",
      ] : [
      "${var.domain}      A  ${oci_core_instance.waffled.public_ip}",
      "${local.ps_host}  A  ${oci_core_instance.waffled.public_ip}",
    ]
  )
}

output "ssh_command" {
  description = "SSH in (e.g. to tail /var/log/waffled-bootstrap.log)."
  value       = "ssh -i ${var.ssh_private_key_path} ubuntu@${oci_core_instance.waffled.public_ip}"
}
