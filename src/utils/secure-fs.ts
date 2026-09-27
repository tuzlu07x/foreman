import { chmodSync, existsSync, mkdirSync } from "node:fs";

// Foreman's config and state directories hold the audit log (tool
// arguments, file paths, prompts), the policy, and the encrypted secret
// store. Nothing in them should be readable by other local users, so the
// directories are 0700 and sensitive files 0600 regardless of the umask.
// chmod failures are ignored: filesystems without POSIX modes (FAT, some
// network mounts, Windows) simply don't support the restriction.

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
}

export function restrictToOwner(...paths: string[]): void {
  for (const path of paths) {
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
}
