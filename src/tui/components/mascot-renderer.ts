import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ChafaRenderResult {
  lines: string[];
  source: "chafa";
}

export interface BlockRenderResult {
  lines: string[];
  source: "block";
}

export type RenderResult = ChafaRenderResult | BlockRenderResult;

let chafaCache: boolean | null = null;

export function detectChafa(): boolean {
  if (chafaCache !== null) return chafaCache;
  try {
    execFileSync("chafa", ["--version"], { stdio: "ignore", timeout: 1000 });
    chafaCache = true;
  } catch {
    chafaCache = false;
  }
  return chafaCache;
}

export function __resetChafaCache(): void {
  chafaCache = null;
}

export function resolveMascotAsset(filename: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "assets", "mascot", filename),
    resolve(here, "..", "..", "assets", "mascot", filename),
    resolve(here, "..", "assets", "mascot", filename),
    resolve(process.cwd(), "assets", "mascot", filename),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function renderChafaPng(
  pngPath: string,
  cols: number,
  rows: number,
): string[] | null {
  try {
    const out = execFileSync(
      "chafa",
      [
        "--format=symbols",
        "--symbols=block+border",
        `--size=${cols}x${rows}`,
        "--polite=on",
        "--animate=off",
        pngPath,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    const lines = out.replace(/\n$/, "").split("\n");
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}
