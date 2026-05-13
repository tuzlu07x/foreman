import { eq } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { secrets } from "../db/schema.js";
import { decrypt, encrypt } from "../identity/encryption.js";

export interface StoredSecretMeta {
  name: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
}

export class SecretNotFoundError extends Error {
  constructor(public readonly secretName: string) {
    super(`No secret named "${secretName}"`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretAlreadyExistsError extends Error {
  constructor(public readonly secretName: string) {
    super(`Secret "${secretName}" already exists — use rotate to replace it`);
    this.name = "SecretAlreadyExistsError";
  }
}

export class SecretStore {
  constructor(
    private readonly db: ForemanDb,
    private readonly masterKey: Buffer,
  ) {}

  add(name: string, value: string): void {
    if (this.exists(name)) throw new SecretAlreadyExistsError(name);
    const payload = encrypt(value, this.masterKey);
    const now = Date.now();
    this.db
      .insert(secrets)
      .values({
        name,
        valueEncrypted: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: null,
      })
      .run();
  }

  rotate(name: string, value: string): void {
    const row = this.db
      .select()
      .from(secrets)
      .where(eq(secrets.name, name))
      .get();
    if (!row) throw new SecretNotFoundError(name);
    const payload = encrypt(value, this.masterKey);
    this.db
      .update(secrets)
      .set({
        valueEncrypted: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
        updatedAt: Date.now(),
      })
      .where(eq(secrets.name, name))
      .run();
  }

  get(name: string): string {
    const row = this.db
      .select()
      .from(secrets)
      .where(eq(secrets.name, name))
      .get();
    if (!row) throw new SecretNotFoundError(name);
    const plaintext = decrypt(
      {
        ciphertext: row.valueEncrypted,
        iv: row.iv,
        authTag: row.authTag,
      },
      this.masterKey,
    );
    this.db
      .update(secrets)
      .set({ lastAccessedAt: Date.now() })
      .where(eq(secrets.name, name))
      .run();
    return plaintext;
  }

  remove(name: string): void {
    const row = this.db
      .select()
      .from(secrets)
      .where(eq(secrets.name, name))
      .get();
    if (!row) throw new SecretNotFoundError(name);
    this.db.delete(secrets).where(eq(secrets.name, name)).run();
  }

  list(): StoredSecretMeta[] {
    return this.db
      .select({
        name: secrets.name,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
        lastAccessedAt: secrets.lastAccessedAt,
      })
      .from(secrets)
      .all();
  }

  exists(name: string): boolean {
    return (
      this.db
        .select({ name: secrets.name })
        .from(secrets)
        .where(eq(secrets.name, name))
        .get() !== undefined
    );
  }
}
