import { sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { privateKeyObjectFromRaw, publicKeyObjectFromRaw } from './keypair.js'

/** Sign a message with a raw 32-byte Ed25519 private key. Returns a 64-byte signature. */
export function sign(message: Buffer | string, privateKey: Buffer): Buffer {
  const data = typeof message === 'string' ? Buffer.from(message) : message
  return cryptoSign(null, data, privateKeyObjectFromRaw(privateKey))
}

/** Verify a signature against a raw 32-byte Ed25519 public key. */
export function verify(
  message: Buffer | string,
  signature: Buffer,
  publicKey: Buffer,
): boolean {
  const data = typeof message === 'string' ? Buffer.from(message) : message
  return cryptoVerify(null, data, publicKeyObjectFromRaw(publicKey), signature)
}
