// Outbound SMTP transport (nodemailer). Deliberately thin and injectable: the SMTP
// options are derived from a household's stored settings (host/port/secure/auth/tls),
// and a module-level `transportFactory` seam lets tests substitute a fake transport
// so we can assert on sends without opening a real socket — the same reason the
// LLM/storage layers are pluggable.
//
// esbuild bundles nodemailer into the runtime image (deps are bundled, tree-shaken),
// so there's no node_modules requirement at runtime.
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from './config'

// The transport-shaping half of a household's row (password already DECRYPTED).
// Digest prefs live elsewhere; this is only what nodemailer needs.
export interface SmtpSettings {
  host: string
  port: number
  secure: boolean // implicit TLS (port 465)
  ignoreCert: boolean // tls.rejectUnauthorized = false
  username: string | null
  password: string | null
  fromName: string | null
  fromAddress: string | null
}

export interface OutgoingMail {
  to: string
  subject: string
  html: string
  text?: string
}

// A minimal transport surface — matches nodemailer's Transporter for the one call we
// make, so a fake can satisfy it in tests.
export interface MailTransport {
  sendMail(opts: {
    from: string
    to: string
    subject: string
    html: string
    text?: string
  }): Promise<unknown>
}

export type TransportFactory = (settings: SmtpSettings) => MailTransport

function defaultTransportFactory(settings: SmtpSettings): MailTransport {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.username
      ? { user: settings.username, pass: settings.password ?? '' }
      : undefined,
    // Only relax cert validation when the operator explicitly opted in (self-signed
    // relays). Off by default — Gmail and any real CA validate fine.
    tls: settings.ignoreCert ? { rejectUnauthorized: false } : undefined,
  }) as unknown as Transporter as MailTransport
}

let transportFactory: TransportFactory = defaultTransportFactory

// Test seam: pass a factory to intercept sends; pass null to restore the real one.
export function setTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? defaultTransportFactory
}

// Build the RFC 5322 From header. Precedence: the household's From address, then the
// operator EMAIL_DEFAULT_FROM_ADDRESS, then the auth username as a last resort.
export function fromHeader(s: SmtpSettings): string {
  const addr = s.fromAddress ?? config.email.defaultFromAddress ?? s.username ?? ''
  return s.fromName ? `${s.fromName} <${addr}>` : addr
}

// Send one message. Throws the transport's error verbatim so callers (e.g. the
// "send test email" route) can surface the real SMTP reason — misconfig is the #1
// support issue for this feature.
export async function sendMail(settings: SmtpSettings, mail: OutgoingMail): Promise<void> {
  const transport = transportFactory(settings)
  await transport.sendMail({
    from: fromHeader(settings),
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  })
}
