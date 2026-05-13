import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  assertKey(key);
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    throw new EncryptionError(
      `Failed to decrypt secret — wrong master key or tampered ciphertext (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(
      `Master key must be exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
}
