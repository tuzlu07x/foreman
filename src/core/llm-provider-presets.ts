import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// =============================================================================
// OpenAI-compatible preset endpoints (#367)
// =============================================================================
//
// Curated list of providers that speak the OpenAI /v1/chat/completions
// shape. User picks a preset; Foreman fills in the endpoint URL + default
// model + asks for a key. Refresh quarterly.

export const LlmPresetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    endpoint: z.string().url(),
    /** Secret-store name where the user's API key lives after they paste it. */
    key_secret_name: z.string().min(1),
    default_model: z.string().min(1),
    /** Other models commonly used at this provider. UI shows them as
     *  suggestions next to the default. */
    alt_models: z.array(z.string().min(1)),
    where_to_get: z.string().url(),
    cost_hint: z.string().min(1),
    description: z.string().min(1),
    /** #370 — Grouping in the preset picker. "open-source" =
     *  open-weights / multi-model hosts (DeepSeek, Qwen, OpenRouter…).
     *  "closed-cloud" = proprietary clouds that ship OpenAI-compat
     *  endpoints (xAI, Cohere, Mistral, Perplexity). Defaults to
     *  open-source so existing registries don't break. */
    category: z.enum(["open-source", "closed-cloud"]).optional(),
  })
  .strict();

export const LlmPresetDocSchema = z
  .object({
    version: z.literal(1),
    presets: z.array(LlmPresetSchema),
  })
  .passthrough();

export type LlmPreset = z.infer<typeof LlmPresetSchema>;
export type LlmPresetDoc = z.infer<typeof LlmPresetDocSchema>;

let cached: LlmPresetDoc | null = null;

export function loadLlmPresets(): LlmPresetDoc {
  if (cached) return cached;
  const path = resolveBundledPresetsPath();
  const raw = readFileSync(path, "utf-8");
  cached = LlmPresetDocSchema.parse(JSON.parse(raw));
  return cached;
}

export function findPreset(doc: LlmPresetDoc, id: string): LlmPreset | null {
  return doc.presets.find((p) => p.id === id) ?? null;
}

export function resolveBundledPresetsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../registry/llm-presets.json"),
    resolve(here, "../registry/llm-presets.json"),
    resolve(process.cwd(), "registry/llm-presets.json"),
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
    `Could not locate llm-presets.json (tried: ${candidates.join(", ")})`,
  );
}

/** For tests — reset the cached registry between runs. */
export function _resetLlmPresetsCache(): void {
  cached = null;
}
