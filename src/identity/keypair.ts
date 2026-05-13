import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getForemanPaths } from '../utils/config.js'

export interface Keypair {
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Buffer
  /** Raw 32-byte Ed25519 private key seed. */
  privateKey: Buffer
}

// DER prefixes for Ed25519. Node's crypto requires structured key formats,
// but agents — and the agents table — store the bare 32-byte halves.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: rawPublicKeyFromObject(publicKey),
    privateKey: rawPrivateKeyFromObject(privateKey),
  }
}

/**
 * Load the master keypair from `~/.foreman/identity.key`, generating it if
 * absent. The private-key file is a bare 32-byte seed with 0600 perms.
 */
export function loadOrCreateMasterKey(): Keypair {
  const { identityPath } = getForemanPaths()
  if (existsSync(identityPath)) {
    const privateKey = readFileSync(identityPath)
    if (privateKey.length !== 32) {
      throw new Error(
        `Expected 32-byte Ed25519 seed at ${identityPath}, got ${privateKey.length} bytes`,
      )
    }
    return {
      privateKey,
      publicKey: derivePublicKey(privateKey),
    }
  }
  const kp = generateKeypair()
  mkdirSync(dirname(identityPath), { recursive: true })
  writeFileSync(identityPath, kp.privateKey, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(identityPath, 0o600)
  return kp
}

export function derivePublicKey(privateKey: Buffer): Buffer {
  return rawPublicKeyFromObject(createPublicKey(privateKeyObjectFromRaw(privateKey)))
}

export function publicKeyObjectFromRaw(raw: Buffer): KeyObject {
  assertLength(raw, 32, 'public key')
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export function privateKeyObjectFromRaw(raw: Buffer): KeyObject {
  assertLength(raw, 32, 'private key')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}

function rawPublicKeyFromObject(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(-32))
}

function rawPrivateKeyFromObject(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'pkcs8' })
  return Buffer.from(der.subarray(-32))
}

function assertLength(buf: Buffer, expected: number, label: string): void {
  if (buf.length !== expected) {
    throw new Error(`Ed25519 ${label} must be ${expected} bytes, got ${buf.length}`)
  }
}
