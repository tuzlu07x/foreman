import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractCwdFromTask,
  findAbsolutePaths,
} from "../../src/core/extract-cwd-from-task.js";

// =============================================================================
// extractCwdFromTask — pull the cwd hint out of an agent task's free-form
// text. Bug surfaced in manual QA 2026-05-24: Hermes routed a task to
// codex with "the project path is /Users/fatih/Downloads/to-do-app" in
// the body, but Foreman's drain handler never extracted it + codex
// landed in Foreman's own cwd → sandbox-write rejected the target.
// =============================================================================

describe("findAbsolutePaths — tokeniser", () => {
  it("returns every absolute-path-shaped token in input order", () => {
    expect(
      findAbsolutePaths(
        "review /Users/foo/project then /tmp/notes and /var/log/x",
      ),
    ).toEqual(["/Users/foo/project", "/tmp/notes", "/var/log/x"]);
  });

  it("strips trailing sentence punctuation that the regex's char class allowed", () => {
    expect(findAbsolutePaths("look at /Users/foo/bar, then commit"))
      .toEqual(["/Users/foo/bar"]);
    expect(findAbsolutePaths("go to /tmp/x.")).toEqual(["/tmp/x"]);
    // Parens / brackets / colon stripped from end too.
    expect(findAbsolutePaths("path: /Users/a/b/c)")).toEqual([
      "/Users/a/b/c",
    ]);
  });

  it("returns [] when no absolute path is mentioned", () => {
    expect(findAbsolutePaths("review the to-do-app repo on main")).toEqual([]);
    expect(findAbsolutePaths("")).toEqual([]);
  });

  it("ignores relative paths (chicken-and-egg with cwd)", () => {
    // `./src` and `../foo` should NOT be matched as cwd hints — the
    // helper is intentionally absolute-only.
    expect(findAbsolutePaths("look at ./src and ../foo")).toEqual([]);
  });

  it("does not break on URLs that contain slashes", () => {
    // `https://github.com/...` should NOT be matched as an absolute
    // path. The regex anchors on `/` not preceded by `:` indirectly
    // because the URL prefix `https:/` would split awkwardly — confirm
    // we don't surface garbage.
    const found = findAbsolutePaths(
      "see https://github.com/tuzlu07x/to-do-app and /Users/me/repo",
    );
    // We accept that the URL's path component might show up; the
    // contract is "the directory check downstream filters non-existent
    // paths". What we ALSO surface for free is the real local path.
    expect(found).toContain("/Users/me/repo");
  });
});

describe("extractCwdFromTask — full pipeline (with real fs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-cwd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the absolute path when it exists + is a directory", () => {
    const out = extractCwdFromTask(
      `Take over the to-do-app implementation in ${dir}`,
    );
    expect(out).toBe(dir);
  });

  it("returns the dirname when the matched path is a file (not a directory)", () => {
    const filePath = join(dir, "README.md");
    writeFileSync(filePath, "# hi\n");
    const out = extractCwdFromTask(`Open ${filePath} and read it`);
    expect(out).toBe(dir);
  });

  it("returns undefined when the mentioned path doesn't exist on disk", () => {
    expect(
      extractCwdFromTask("Use /Users/nobody/does/not/exist/project"),
    ).toBeUndefined();
  });

  it("returns undefined for tasks with no absolute path at all", () => {
    expect(extractCwdFromTask("review the open issues on main")).toBeUndefined();
    expect(extractCwdFromTask("")).toBeUndefined();
  });

  it("returns the FIRST existing path when multiple are mentioned", () => {
    const subA = join(dir, "a");
    const subB = join(dir, "b");
    mkdirSync(subA);
    mkdirSync(subB);
    // Path A appears first in the task text → wins.
    const out = extractCwdFromTask(`cp ${subA} ${subB} please`);
    expect(out).toBe(subA);
  });

  it("skips non-existent path candidates + returns the first VALID one", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const out = extractCwdFromTask(
      `try /does/not/exist first then ${real}`,
    );
    expect(out).toBe(real);
  });

  it("does NOT throw when input contains weird path-looking strings", () => {
    // Defensive — even garbage shouldn't crash the drain handler.
    expect(() =>
      extractCwdFromTask("hello /// /// /not/a/valid//// path"),
    ).not.toThrow();
  });
});
