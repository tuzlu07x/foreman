import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

// Foreman's config and state directories hold the audit log (tool
// arguments, file paths, prompts), the policy, and the encrypted secret
// store. Nothing in them should be readable by other local users, so the
// directories are 0700 and sensitive files 0600 regardless of the umask.
// chmod failures are ignored: filesystems without POSIX modes (FAT, some
// network mounts, Windows) simply don't support the restriction.

/** Create `dir` owner-only. An existing directory is tightened only when
 *  it is recognisably Foreman's own (`foreman`, `.foreman*`): a custom
 *  FOREMAN_HOME may point at a shared directory, whose mode is the user's
 *  business. The sensitive files inside are 0600 either way. */
export function ensurePrivateDir(dir: string): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existed && !/^\.?foreman/i.test(basename(dir))) return;
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
