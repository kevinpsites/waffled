package app.waffled.core.network

/**
 * The result of checking a user-entered server address.
 */
sealed interface ServerUrlVerdict {
    /** Usable. [url] is the normalised form to store. */
    data class Ok(val url: String) : ServerUrlVerdict

    /** Not a URL we can use at all. */
    data class Invalid(val reason: String) : ServerUrlVerdict

    /**
     * Well-formed, but plain HTTP to a *public* host — that would put the password on
     * the open internet. Refused deliberately; see docs/product/android-port-plan.md §7.5.
     */
    data class InsecurePublic(val host: String) : ServerUrlVerdict
}

/**
 * Server-address handling for a self-hosted product.
 *
 * The cleartext policy lives here rather than in `network_security_config.xml` because
 * Android's config matches literal hostnames and has no CIDR support — and our users
 * type an arbitrary LAN IP at runtime, so there is nothing to enumerate up front.
 */
object ServerUrl {

    /**
     * Tidy a typed address into a canonical origin, or `null` if it isn't usable.
     * Bare `host:port` is assumed to be `http://` — that is what self-hosters type.
     */
    fun normalize(input: String?): String? {
        val raw = input?.trim()?.trimEnd('/') ?: return null
        if (raw.isEmpty()) return null

        val withScheme = when {
            raw.startsWith("http://", ignoreCase = true) -> raw
            raw.startsWith("https://", ignoreCase = true) -> raw
            // Any other explicit scheme is not something we can talk to.
            raw.contains("://") -> return null
            else -> "http://$raw"
        }

        val host = hostOf(withScheme) ?: return null
        if (host.isEmpty() || host.any { it.isWhitespace() }) return null
        // A host must look like a hostname or an IP — letters, digits, dots, dashes.
        if (!host.all { it.isLetterOrDigit() || it == '.' || it == '-' }) return null

        return withScheme
    }

    /** The host portion of a normalised URL, lowercased and without port. */
    fun hostOf(url: String): String? {
        val afterScheme = url.substringAfter("://", missingDelimiterValue = "")
        if (afterScheme.isEmpty()) return null
        return afterScheme
            .substringBefore('/')
            .substringBefore('?')
            .substringBefore(':')
            .lowercase()
            .ifEmpty { null }
    }

    /**
     * Is plain HTTP acceptable for this host?
     *
     * True for loopback, the emulator's host alias, RFC1918 ranges and `.local` mDNS
     * names — i.e. a home network. False for anything reachable from the public
     * internet.
     */
    fun cleartextAllowed(host: String): Boolean {
        val h = host.trim().lowercase()
        if (h == "localhost" || h.endsWith(".localhost")) return true
        if (h == "local" || h.endsWith(".local")) return true

        val octets = h.split('.')
        if (octets.size == 4 && octets.all { it.toIntOrNull() in 0..255 }) {
            val a = octets[0].toInt()
            val b = octets[1].toInt()
            return when {
                a == 127 -> true                 // loopback
                a == 10 -> true                  // 10/8
                a == 192 && b == 168 -> true     // 192.168/16
                a == 172 && b in 16..31 -> true  // 172.16/12 — note the bounds
                a == 169 && b == 254 -> true     // link-local
                else -> false
            }
        }
        return false
    }

    /** The check the server-address setting runs before saving. */
    fun validate(input: String?): ServerUrlVerdict {
        val url = normalize(input)
            ?: return ServerUrlVerdict.Invalid("That doesn't look like a server address.")
        val host = hostOf(url)
            ?: return ServerUrlVerdict.Invalid("That doesn't look like a server address.")

        val isHttps = url.startsWith("https://", ignoreCase = true)
        if (!isHttps && !cleartextAllowed(host)) {
            return ServerUrlVerdict.InsecurePublic(host)
        }
        return ServerUrlVerdict.Ok(url)
    }
}
