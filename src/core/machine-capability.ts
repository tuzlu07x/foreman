import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir, cpus, totalmem, freemem, platform, arch } from "node:os";

// =============================================================================
// Machine capability detector (#367)
// =============================================================================
//
// Single source of truth for "what can this machine run". Used by the
// wizard's Foreman-LLM step to enable/disable Ollama models, surface
// install commands per OS, and warn before a small box tries to load a
// huge model. Synchronous + dependency-free — we want it cheap enough to
// call at every wizard render without a measurable hit.

export type DetectedOs = "darwin" | "linux" | "win32" | "other";
export type DetectedArch = "arm64" | "x86_64" | "other";

export interface MachineCapability {
  os: DetectedOs;
  arch: DetectedArch;
  /** Total system RAM in bytes. */
  totalRamBytes: number;
  /** Free RAM at probe time, in bytes. Coarse — Activity Monitor / `free`
   *  will show a different number, but the relative magnitude is right. */
  freeRamBytes: number;
  cpuCount: number;
  /** Bytes free in the user's home filesystem — proxy for where Ollama
   *  models land (`~/.ollama/models` on macOS/Linux). null if statfs
   *  fails (Windows older Node, sandboxed). */
  freeDiskBytesHome: number | null;
  /** Apple Silicon Macs report unified-memory Metal GPUs; NVIDIA boxes
   *  optionally report VRAM. CPU-only inference is the safe fallback.
   *  Detection here is best-effort + cheap; PRs welcome to extend. */
  gpu: GpuInfo;
}

export interface GpuInfo {
  /** None detected → CPU-only inference (slower, OK for small models). */
  kind: "none" | "apple-metal" | "nvidia-cuda" | "unknown";
  /** Discrete VRAM if known. Apple Silicon reports null — unified memory
   *  is the same as totalRamBytes. */
  vramBytes: number | null;
}

export interface DetectOptions {
  /** Test override — pretend the machine has this many bytes of RAM. */
  totalRamBytesOverride?: number;
  freeRamBytesOverride?: number;
  /** Test override — pretend the home filesystem has this much free. */
  freeDiskBytesOverride?: number | null;
  osOverride?: DetectedOs;
  archOverride?: DetectedArch;
  /** Inject a fake `os.cpus()` count without the test having to mock os. */
  cpuCountOverride?: number;
  /** Skip the actual GPU probe (which forks `system_profiler` / `nvidia-smi`
   *  on real machines). Tests pass a fixed GpuInfo here. */
  gpuOverride?: GpuInfo;
  /** Override the home dir for the statfs call. */
  homeDirOverride?: string;
}

const BYTES_PER_GB = 1024 ** 3;

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

export function detectMachineCapability(
  options: DetectOptions = {},
): MachineCapability {
  const os = options.osOverride ?? normaliseOs(platform());
  const archDetected = options.archOverride ?? normaliseArch(arch());
  const totalRamBytes = options.totalRamBytesOverride ?? totalmem();
  const freeRamBytes = options.freeRamBytesOverride ?? freemem();
  const cpuCount = options.cpuCountOverride ?? cpus().length;
  const home = options.homeDirOverride ?? homedir();
  const freeDiskBytesHome =
    options.freeDiskBytesOverride !== undefined
      ? options.freeDiskBytesOverride
      : safeFreeDisk(home);
  const gpu = options.gpuOverride ?? detectGpu(os);
  return {
    os,
    arch: archDetected,
    totalRamBytes,
    freeRamBytes,
    cpuCount,
    freeDiskBytesHome,
    gpu,
  };
}

function normaliseOs(p: string): DetectedOs {
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

function normaliseArch(a: string): DetectedArch {
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x86_64";
  return "other";
}

function safeFreeDisk(dir: string): number | null {
  try {
    const stat = statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function detectGpu(os: DetectedOs): GpuInfo {
  if (os === "darwin") {
    // Every modern Mac (Intel + Apple Silicon) has a GPU exposed via Metal.
    // Apple Silicon uses unified memory — treat VRAM as null since it's
    // the same pool as system RAM. We don't fork `system_profiler` here:
    // it's slow (~600ms) and the answer is always "Metal" on supported
    // hardware.
    return { kind: "apple-metal", vramBytes: null };
  }
  if (os === "linux") {
    // Best-effort: try nvidia-smi. Failure → no GPU detected (treat as CPU-only).
    try {
      const out = execFileSync("nvidia-smi", [
        "--query-gpu=memory.total",
        "--format=csv,noheader,nounits",
      ], { encoding: "utf-8", timeout: 1500 }).trim();
      const mib = parseInt(out.split(/\s+/)[0] ?? "", 10);
      if (Number.isFinite(mib) && mib > 0) {
        return { kind: "nvidia-cuda", vramBytes: mib * 1024 * 1024 };
      }
    } catch {
      /* nvidia-smi missing or fails — no GPU detected */
    }
    return { kind: "none", vramBytes: null };
  }
  return { kind: "unknown", vramBytes: null };
}

// ----------------------------------------------------------------------------
// Convenience predicates for the wizard
// ----------------------------------------------------------------------------

/**
 * RAM-usable-for-inference. For Apple Silicon (unified memory) and other
 * shared-memory machines, leave 4 GB headroom for the OS + active apps so
 * the user's machine doesn't grind. The caller can override the headroom.
 */
export function usableInferenceRamBytes(
  cap: MachineCapability,
  headroomBytes = 4 * BYTES_PER_GB,
): number {
  // Free RAM at probe time is the conservative answer when it's smaller
  // than total - headroom; total - headroom is the optimistic upper bound
  // after closing other apps. Use the larger of (free, total - headroom)
  // so we don't artificially block models the user could run after
  // closing Slack.
  const optimistic = Math.max(0, cap.totalRamBytes - headroomBytes);
  return Math.max(cap.freeRamBytes, optimistic);
}
