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
  value       = var.domain != "" ? "https://powersync.${var.domain}" : "http://${oci_core_instance.waffled.public_ip}:8090"
}

output "dns_records_needed" {
  description = "DNS records to create (HTTPS mode) so auto-TLS can succeed."
  value = var.domain != "" ? [
    "${var.domain}            A  ${oci_core_instance.waffled.public_ip}",
    "powersync.${var.domain}  A  ${oci_core_instance.waffled.public_ip}",
  ] : []
}

output "ssh_command" {
  description = "SSH in (e.g. to tail /var/log/waffled-bootstrap.log)."
  value       = "ssh ubuntu@${oci_core_instance.waffled.public_ip}"
}
