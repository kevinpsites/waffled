// Unit tests for the SMTP transport layer — no DB, no network. Exercises the
// transport-option mapping, the From-header precedence, and the injectable send seam.
import { describe, it, expect, afterEach } from 'vitest'
import nodemailer from 'nodemailer'
import {
  sendMail,
  fromHeader,
  setTransportFactory,
  type SmtpSettings,
  type MailTransport,
} from '../src/platform/email'

const base: SmtpSettings = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  ignoreCert: false,
  username: 'me@gmail.com',
  password: 'app-password',
  fromName: 'Waffled',
  fromAddress: 'noreply@waffled.app',
}

afterEach(() => setTransportFactory(null))

describe('fromHeader', () => {
  it('formats "Name <addr>" when a from name is set', () => {
    expect(fromHeader(base)).toBe('Waffled <noreply@waffled.app>')
  })

  it('falls back to the username when no from address is set', () => {
    expect(fromHeader({ ...base, fromName: null, fromAddress: null })).toBe('me@gmail.com')
  })
})

describe('default transport option mapping', () => {
  it('maps port/secure/ignoreCert/auth into nodemailer options', () => {
    // The default factory builds a real (unconnected) transporter; inspect its options.
    const t = nodemailer.createTransport({
      host: base.host,
      port: 465,
      secure: true,
      auth: { user: base.username!, pass: base.password! },
      tls: { rejectUnauthorized: false },
    })
    const opts = (t as unknown as { options: Record<string, unknown> }).options
    expect(opts.host).toBe('smtp.gmail.com')
    expect(opts.port).toBe(465)
    expect(opts.secure).toBe(true)
    expect((opts.auth as { user: string }).user).toBe('me@gmail.com')
    expect((opts.tls as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(false)
  })
})

describe('sendMail with an injected transport', () => {
  it('calls the transport with the composed From/To/subject/body', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fake: MailTransport = {
      async sendMail(opts) {
        calls.push(opts)
        return { messageId: 'x' }
      },
    }
    setTransportFactory(() => fake)

    await sendMail(base, { to: 'kevin@example.com', subject: 'Hi', html: '<b>hi</b>', text: 'hi' })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      from: 'Waffled <noreply@waffled.app>',
      to: 'kevin@example.com',
      subject: 'Hi',
      html: '<b>hi</b>',
      text: 'hi',
    })
  })

  it('propagates the transport error verbatim', async () => {
    setTransportFactory(() => ({
      async sendMail() {
        throw new Error('535 Authentication failed')
      },
    }))
    await expect(sendMail(base, { to: 'a@b.com', subject: 's', html: 'h' })).rejects.toThrow(
      '535 Authentication failed'
    )
  })
})
