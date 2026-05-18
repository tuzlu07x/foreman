import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  bytesToGb,
  type MachineCapability,
  usableInferenceRamBytes,
} from "./machine-capability.js";

// =============================================================================
// Ollama model registry + can-run gating (#367)
// =============================================================================
//
// Bundled catalog of popular Ollama models with size + RAM hints, plus
// `canRun(model, machine)` that decides whether the wizard's model picker
// shows a row as recommended / balanced / tight / disabled-ram / disabled-disk.
//
// User vision (round-3):
//   "listede olsun ama disabled olsun, kullanici neden secemedigini de bilsin"
// → no model is hidden; oversize ones render as disabled rows with the
// exact reason next to them.

export const OllamaModelSchema = z.object({
  name: z.string().min(1),
  family: z.string().min(1),
  params_b: z.number().positive(),
  /** Approximate GB the pulled file takes on disk. */
  download_size_gb: z.number().positive(),
  /** Approximate GB resident at inference time (includes KV cache). */
  runtime_ram_gb: z.number().positive(),
  context_length: z.number().int().positive(),
  license: z.string().min(1),
  description: z.string().min(1),
  recommended: z.boolean(),
});

export const OllamaModelDocSchema = z.object({
  version: z.literal(1),
  models: z.array(OllamaModelSchema),
}).passthrough();

export type OllamaModel = z.infer<typeof OllamaModelSchema>;
export type OllamaModelDoc = z.infer<typeof OllamaModelDocSchema>;

/** Five-state classification used by the picker UI. The ratio bands are
 *  intentionally generous so a 16 GB Mac can still pick a 7B model — the
 *  ceiling on usable RAM (`usableInferenceRamBytes`) already leaves OS
 *  headroom. Tighter than this would block too many viable picks. */
export type RunStatus =
  | { state: "recommended"; ramPct: number }
  | { state: "balanced"; ramPct: number }
  | { state: "tight"; ramPct: number; reason: string }
  | { state: "disabled-ram"; reason: string }
  | { state: "disabled-disk"; reason: string };

const RUNTIME_BUFFER = 1024 ** 3; // bytes — flat extra to avoid "exactly fits" surprises

/**
 * Decide if a machine can run a given Ollama model, and at what comfort
 * level. The picker uses this to enable/disable + label rows.
 */
export function canRunModel(
  model: OllamaModel,
  machine: MachineCapability,
  options: { headroomBytes?: number } = {},
): RunStatus {
  const usable = usableInferenceRamBytes(machine, options.headroomBytes);
  const need = model.runtime_ram_gb * 1024 ** 3 + RUNTIME_BUFFER;
  const ramPct = Math.round((need / usable) * 100);

  // Disk first — no point worrying about RAM if we can't even pull the file.
  if (machine.freeDiskBytesHome !== null) {
    const needDisk = model.download_size_gb * 1024 ** 3;
    if (needDisk > machine.freeDiskBytesHome) {
      return {
        state: "disabled-disk",
        reason: `download is ${model.download_size_gb} GB, only ${bytesToGb(
          machine.freeDiskBytesHome,
        ).toFixed(1)} GB free`,
      };
    }
  }

  if (need > usable) {
    return {
      state: "disabled-ram",
      reason: `needs ~${model.runtime_ram_gb} GB, you have ${bytesToGb(
        usable,
      ).toFixed(1)} GB usable`,
    };
  }
  if (ramPct >= 70) {
    return {
      state: "tight",
      ramPct,
      reason: `tight — ${ramPct}% of usable RAM`,
    };
  }
  if (ramPct >= 50) return { state: "balanced", ramPct };
  return { state: "recommended", ramPct };
}

let cachedDoc: OllamaModelDoc | null = null;

export function loadOllamaModels(): OllamaModelDoc {
  if (cachedDoc) return cachedDoc;
  const path = resolveBundledOllamaModelsPath();
  const raw = readFileSync(path, "utf-8");
  const parsed = OllamaModelDocSchema.parse(JSON.parse(raw));
  cachedDoc = parsed;
  return parsed;
}

export function resolveBundledOllamaModelsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/core/ollama-models.js → ../../registry/ollama-models.json
  // src/core/ollama-models.ts  → ../../registry/ollama-models.json
  const candidates = [
    resolve(here, "../../registry/ollama-models.json"),
    resolve(here, "../registry/ollama-models.json"),
    resolve(process.cwd(), "registry/ollama-models.json"),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, "utf-8");
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Could not locate ollama-models.json (tried: ${candidates.join(", ")})`,
  );
}

/** For tests — reset the cached registry between runs. */
export function _resetOllamaModelsCache(): void {
  cachedDoc = null;
}
