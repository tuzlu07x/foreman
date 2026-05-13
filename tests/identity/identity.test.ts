import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  derivePublicKey,
  generateKeypair,
  loadOrCreateMasterKey,
} from '../../src/identity/keypair.js'
import { sign, verify } from '../../src/identity/signing.js'

describe('keypair', () => {
  it('generates a 32-byte Ed25519 public/private pair', () => {
    const kp = generateKeypair()
    expect(kp.publicKey).toHaveLength(32)
    expect(kp.privateKey).toHaveLength(32)
    expect(kp.publicKey.equals(kp.privateKey)).toBe(false)
  })

  it('derives the same public key from a private seed', () => {
    const kp = generateKeypair()
    expect(derivePublicKey(kp.privateKey).equals(kp.publicKey)).toBe(true)
  })
})

describe('signing', () => {
  it('round-trips a signature with the matching public key', () => {
    const kp = generateKeypair()
    const sig = sign('hello, foreman', kp.privateKey)
    expect(sig).toHaveLength(64)
    expect(verify('hello, foreman', sig, kp.publicKey)).toBe(true)
  })

  it('fails verification when the message is tampered', () => {
    const kp = generateKeypair()
    const sig = sign('approve read_file(.env)', kp.privateKey)
    expect(verify('approve read_file(.foo)', sig, kp.publicKey)).toBe(false)
  })

  it('fails verification when the signature is tampered', () => {
    const kp = generateKeypair()
    const sig = sign(Buffer.from([1, 2, 3, 4]), kp.privateKey)
    const tampered = Buffer.from(sig)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    expect(verify(Buffer.from([1, 2, 3, 4]), tampered, kp.publicKey)).toBe(false)
  })

  it('fails verification with a different public key', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    const sig = sign('msg', a.privateKey)
    expect(verify('msg', sig, b.publicKey)).toBe(false)
  })
})

describe('loadOrCreateMasterKey', () => {
  let tmpHome: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-identity-'))
    savedHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmpHome
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates identity.key on first call and reuses it on the second', () => {
    const first = loadOrCreateMasterKey()
    const second = loadOrCreateMasterKey()
    expect(second.privateKey.equals(first.privateKey)).toBe(true)
    expect(second.publicKey.equals(first.publicKey)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')(
    'persists identity.key with 0600 perms on Unix',
    () => {
      loadOrCreateMasterKey()
      const stat = statSync(join(tmpHome, 'identity.key'))
      expect(stat.mode & 0o777).toBe(0o600)
    },
  )

  it('produces a working master key that can sign and verify', () => {
    const kp = loadOrCreateMasterKey()
    const sig = sign('foreman boot', kp.privateKey)
    expect(verify('foreman boot', sig, kp.publicKey)).toBe(true)
  })
})
