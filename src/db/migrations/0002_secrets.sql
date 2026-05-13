-- Foreman Secret Store: encrypted (AES-256-GCM) per-agent key vault.
-- Master key is held in ~/.foreman/secrets.key (0600), never in the DB.

CREATE TABLE `secrets` (
  `name` TEXT PRIMARY KEY NOT NULL,
  `value_encrypted` BLOB NOT NULL,
  `iv` BLOB NOT NULL,
  `auth_tag` BLOB NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `last_accessed_at` INTEGER
);
