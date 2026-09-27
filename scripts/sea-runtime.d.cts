// Types for scripts/sea-runtime.cjs, used by its tests.

export interface PayloadFile {
  path: string;
  sha256: string;
  mode: number;
  /** base64 */
  data: string;
}

export interface Payload {
  version: string;
  digest: string;
  files: PayloadFile[];
}

export type Invocation = { mode: "cli"; argv: string[] } | { mode: "script"; argv: string[] };

export type Booted =
  | { mode: "script" }
  | {
      mode: "cli";
      metaUrl: string;
      resolve(specifier: string): never;
      loadAddon(name: string): unknown;
    };

export const ADDON: string;
export function boot(payload: Payload): Booted;
export function classifyInvocation(argv: string[], execPath: string): Invocation;
export function ensureRuntimeDir(payload: Payload, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;
export function runtimeRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string;
export function verifyDir(dir: string, files: PayloadFile[]): boolean;
export function sha256(buf: Buffer | string): string;
