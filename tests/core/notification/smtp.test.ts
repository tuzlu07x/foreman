import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket, createSecureContext } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { sendMail, SmtpError, type SmtpOptions } from '../../../src/core/notification/smtp.js'

// A scripted in-process SMTP server: records the transcript and the DATA
// payload, optionally offers STARTTLS with a throwaway self-signed cert.

interface FakeSmtp {
  port: number
  transcript: string[]
  data: string[]
  close(): Promise<void>
}

function startServer(opts: { starttls?: { key: string; cert: string }; rejectRcpt?: boolean; authMechs?: string } = {}): Promise<FakeSmtp> {
  const transcript: string[] = []
  const data: string[] = []
  const server: Server = createServer((raw: Socket) => {
    let socket: Socket | TLSSocket = raw
    let inData = false
    let buf = ''
    let body = ''
    const reply = (line: string) => socket.write(`${line}\r\n`)
    const ehlo = () => {
      const caps = ['250-fake.local', `250-AUTH ${opts.authMechs ?? 'PLAIN LOGIN'}`]
      if (opts.starttls && !(socket instanceof TLSSocket)) caps.push('250-STARTTLS')
      caps.push('250 8BITMIME')
      socket.write(caps.join('\r\n') + '\r\n')
    }
    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false
          data.push(body)
          body = ''
          reply('250 queued')
        } else body += `${line}\n`
        return
      }
      transcript.push(line)
      const verb = line.split(' ')[0]!.toUpperCase()
      if (verb === 'EHLO') ehlo()
      else if (verb === 'STARTTLS') {
        reply('220 go ahead')
        socket.removeAllListeners('data')
        const secure = new TLSSocket(socket, {
          isServer: true,
          secureContext: createSecureContext({ key: opts.starttls!.key, cert: opts.starttls!.cert }),
        })
        socket = secure
        secure.on('data', onData)
      } else if (verb === 'AUTH') {
        if (line.startsWith('AUTH LOGIN')) reply('334 VXNlcm5hbWU6')
        else reply('235 ok')
      } else if (/^[A-Za-z0-9+/=]+$/.test(line) && transcript.at(-2)?.startsWith('AUTH LOGIN')) reply('334 UGFzc3dvcmQ6')
      else if (/^[A-Za-z0-9+/=]+$/.test(line) && transcript.at(-3)?.startsWith('AUTH LOGIN')) reply('235 ok')
      else if (verb === 'MAIL') reply('250 ok')
      else if (verb === 'RCPT') reply(opts.rejectRcpt ? '550 no such user' : '250 ok')
      else if (verb === 'DATA') {
        inData = true
        reply('354 end with .')
      } else if (verb === 'QUIT') {
        reply('221 bye')
        socket.end()
      } else reply('500 what')
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        onLine(line)
      }
    }
    raw.on('data', onData)
    raw.on('error', () => undefined)
    reply('220 fake.local ESMTP')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, transcript, data, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

const base = (port: number): SmtpOptions => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  from: 'foreman@example.com',
  to: ['me@example.com'],
  timeoutMs: 5_000,
})

describe('sendMail', () => {
  const servers: FakeSmtp[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  it('delivers a message with AUTH PLAIN to a local relay', async () => {
    const s = await startServer()
    servers.push(s)
    await sendMail({ ...base(s.port), username: 'u', password: 'p' }, { subject: 'Hermes wants .env', text: 'line 1\n.line 2' })
    expect(s.transcript[0]).toMatch(/^EHLO /)
    expect(s.transcript).toContain(`AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`)
    expect(s.transcript).toContain('MAIL FROM:<foreman@example.com>')
    expect(s.transcript).toContain('RCPT TO:<me@example.com>')
    const message = s.data[0]!
    expect(message).toContain('Subject: Hermes wants .env')
    expect(message).toContain('Content-Transfer-Encoding: base64')
    const body = message.split('\n\n')[1]!.replace(/\n/g, '')
    expect(Buffer.from(body, 'base64').toString('utf-8')).toBe('line 1\r\n.line 2')
  })

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const s = await startServer({ authMechs: 'LOGIN' })
    servers.push(s)
    await sendMail({ ...base(s.port), username: 'u', password: 'p' }, { subject: 's', text: 't' })
    expect(s.transcript).toContain('AUTH LOGIN')
    expect(s.data).toHaveLength(1)
  })

  it('encodes non-ASCII subjects (RFC 2047)', async () => {
    const s = await startServer()
    servers.push(s)
    await sendMail(base(s.port), { subject: 'Günlük özet', text: 'ok' })
    expect(s.data[0]).toContain(`Subject: =?UTF-8?B?${Buffer.from('Günlük özet').toString('base64')}?=`)
  })

  it('refuses header injection and bad addresses before connecting', async () => {
    await expect(sendMail(base(1), { subject: 'x\r\nBcc: evil@example.com', text: '' })).rejects.toThrow(SmtpError)
    await expect(sendMail({ ...base(1), to: ['a@example.com>\r\nRCPT TO:<b@example.com'] }, { subject: 's', text: '' })).rejects.toThrow(/invalid email/)
  })

  it('refuses to send credentials in clear text to a remote host', async () => {
    await expect(
      sendMail({ ...base(25), host: 'smtp.example.com', username: 'u', password: 'p' }, { subject: 's', text: '' }),
    ).rejects.toThrow(/unencrypted/)
  })

  it('surfaces a rejected recipient as an SmtpError with the code', async () => {
    const s = await startServer({ rejectRcpt: true })
    servers.push(s)
    const err = await sendMail(base(s.port), { subject: 's', text: 't' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SmtpError)
    expect((err as SmtpError).code).toBe(550)
  })

  it('upgrades with STARTTLS and verifies the server certificate', async () => {
    let dir: string | null = null
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' })
    } catch {
      return // openssl unavailable — covered on CI runners
    }
    dir = mkdtempSync(join(tmpdir(), 'foreman-smtp-tls-'))
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { stdio: 'ignore' },
    )
    const key = readFileSync(join(dir, 'key.pem'), 'utf-8')
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf-8')
    try {
      const s = await startServer({ starttls: { key, cert } })
      servers.push(s)
      await sendMail(
        { ...base(s.port), host: 'localhost', security: 'starttls', username: 'u', password: 'p', tls: { ca: cert } },
        { subject: 'tls', text: 'secure' },
      )
      expect(s.transcript).toContain('STARTTLS')
      // EHLO is repeated inside the TLS session, and AUTH only happens there.
      expect(s.transcript.filter((l) => l.startsWith('EHLO'))).toHaveLength(2)
      expect(s.transcript.indexOf('STARTTLS')).toBeLessThan(s.transcript.findIndex((l) => l.startsWith('AUTH')))
      // An untrusted certificate is rejected.
      await expect(
        sendMail({ ...base(s.port), host: 'localhost', security: 'starttls' }, { subject: 'x', text: 'y' }),
      ).rejects.toThrow()
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })
})
