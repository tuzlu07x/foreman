import { eq } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { secrets } from "../db/schema.js";
import { decrypt, encrypt, EncryptionError } from "../identity/encryption.js";

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

/** Names under this prefix hold agent identity tokens (#618). The generic
 *  add / rotate / get refuse them, so no agent-facing path (the MCP
 *  `secrets/get` tool, hub or notify secret refs, `foreman secrets show`)
 *  can read or overwrite one; only the agent-token module uses the
 *  `*Reserved` methods. */
export const RESERVED_SECRET_PREFIX = "foreman-agent-token:";

/** What a secret name you choose may look like: the same charset
 *  `${secret:<name>}` references accept in mcp.yaml (letters, digits, '.',
 *  '_', '-'; starting with a letter or digit; at most 128). Names land in
 *  config files, audit rows and terminal output. */
export const SECRET_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const SECRET_NAME_RE = new RegExp(`^${SECRET_NAME_PATTERN}$`);

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function isReservedSecretName(name: string): boolean {
  return name.startsWith(RESERVED_SECRET_PREFIX);
}

export class ReservedSecretError extends Error {
  constructor(public readonly secretName: string) {
    super(`"${secretName}" is an agent identity token — manage it with \`foreman agent token\``);
    this.name = "ReservedSecretError";
  }
}

/** The stored value doesn't decrypt with this secrets.key: the key was
 *  lost and replaced, or it is the wrong file (#657). Friendly: the CLI
 *  prints the message instead of a stack trace. Still an EncryptionError,
 *  so nothing that catches those changes. */
export class SecretDecryptError extends EncryptionError {
  readonly foremanFriendly = true;
  constructor(public readonly secretName: string) {
    super(
      `can't decrypt secret "${secretName}": secrets.key isn't the key it was stored with. ` +
        "Restore the original secrets.key, or remove the secret and add it again ('foreman doctor' checks the key).",
    );
    this.name = "SecretDecryptError";
  }
}

export class SecretStore {
  constructor(
    private readonly db: ForemanDb,
    private readonly masterKey: Buffer,
  ) {}

  add(name: string, value: string): void {
    if (isReservedSecretName(name)) throw new ReservedSecretError(name);
    this.insert(name, value);
  }

  private insert(name: string, value: string): void {
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
    if (isReservedSecretName(name)) throw new ReservedSecretError(name);
    this.update(name, value);
  }

  private update(name: string, value: string): void {
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

  /** `touch: false` reads without recording an access (status checks). */
  get(name: string, opts: { touch?: boolean } = {}): string {
    if (isReservedSecretName(name)) throw new ReservedSecretError(name);
    return this.read(name, opts.touch !== false);
  }

  /** Read a reserved secret without bumping `last_accessed_at`. */
  getReserved(name: string): string {
    if (!isReservedSecretName(name)) throw new Error(`"${name}" is not a reserved secret name`);
    return this.read(name, false);
  }

  /** Create or replace a reserved secret. */
  putReserved(name: string, value: string): void {
    if (!isReservedSecretName(name)) throw new Error(`"${name}" is not a reserved secret name`);
    if (this.exists(name)) this.update(name, value);
    else this.insert(name, value);
  }

  private read(name: string, touch = true): string {
    const row = this.db
      .select()
      .from(secrets)
      .where(eq(secrets.name, name))
      .get();
    if (!row) throw new SecretNotFoundError(name);
    let plaintext: string;
    try {
      plaintext = decrypt(
        {
          ciphertext: row.valueEncrypted,
          iv: row.iv,
          authTag: row.authTag,
        },
        this.masterKey,
      );
    } catch (err) {
      if (err instanceof EncryptionError) throw new SecretDecryptError(name);
      throw err;
    }
    if (touch) {
      this.db
        .update(secrets)
        .set({ lastAccessedAt: Date.now() })
        .where(eq(secrets.name, name))
        .run();
    }
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

  meta(name: string): StoredSecretMeta | null {
    return (
      this.db
        .select({
          name: secrets.name,
          createdAt: secrets.createdAt,
          updatedAt: secrets.updatedAt,
          lastAccessedAt: secrets.lastAccessedAt,
        })
        .from(secrets)
        .where(eq(secrets.name, name))
        .get() ?? null
    );
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
