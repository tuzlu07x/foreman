import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getForemanPaths } from "../utils/config.js";
import { generateMasterKey } from "./encryption.js";

const MASTER_KEY_BYTES = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

// Loads (or creates) the 32-byte AES-256 master key used by the Secret Store.
// File path is ~/.foreman/secrets.key with 0600 perms; never co-located in DB.
export function loadOrCreateSecretsMasterKey(): Buffer {
  const { secretsKeyPath } = getForemanPaths();
  if (existsSync(secretsKeyPath)) {
    const key = readFileSync(secretsKeyPath);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new MasterKeyError(
        `Expected ${MASTER_KEY_BYTES}-byte master key at ${secretsKeyPath}, got ${key.length} bytes`,
      );
    }
    return key;
  }
  const key = generateMasterKey();
  mkdirSync(dirname(secretsKeyPath), { recursive: true });
  writeFileSync(secretsKeyPath, key, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(secretsKeyPath, 0o600);
  return key;
}
