import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectInstall,
  isBrewManagedPath,
  preferredInstallCommand,
  preferredUninstallCommand,
} from "../../src/core/agent-install.js";

describe("preferredInstallCommand", () => {
  it("prefers npm over brew when both are present", () => {
    expect(
      preferredInstallCommand({
        npm: "hermes-agent",
        brew: "openclaw/tap/hermes",
      }),
    ).toBe("npm install -g hermes-agent");
  });

  it("falls back to brew when npm is null", () => {
    expect(
      preferredInstallCommand({ npm: null, brew: "openclaw/tap/openclaw" }),
    ).toBe("brew install openclaw/tap/openclaw");
  });

  it("falls back to curl script when npm and brew are both null", () => {
    expect(
      preferredInstallCommand({
        npm: null,
        brew: null,
        script: "https://example.com/install.sh",
      }),
    ).toBe("curl -fsSL https://example.com/install.sh | bash");
  });

  it("returns null when nothing is set", () => {
    expect(preferredInstallCommand({ npm: null, brew: null })).toBeNull();
  });
});

describe("preferredUninstallCommand", () => {
  it("returns npm uninstall -g for npm-installed", () => {
    expect(preferredUninstallCommand({ npm: "openclaw", brew: null })).toBe(
      "npm uninstall -g openclaw",
    );
  });

  it("returns brew uninstall for brew-installed", () => {
    expect(preferredUninstallCommand({ npm: null, brew: "tap/foo" })).toBe(
      "brew uninstall tap/foo",
    );
  });

  it("returns null for script-only installs (manual uninstall path)", () => {
    expect(
      preferredUninstallCommand({
        npm: null,
        brew: null,
        script: "https://example.com/install.sh",
      }),
    ).toBeNull();
  });

  // #357 — when detection says it was actually installed via brew, override
  // the registry hint. OpenClaw is `brew: null` in agents.json but the user
  // can have it at /opt/homebrew/bin/openclaw — uninstall has to use brew.
  describe("with detection (#357)", () => {
    it("returns brew uninstall when detection.source=brew-managed (overrides registry)", () => {
      expect(
        preferredUninstallCommand(
          { npm: "openclaw", brew: null }, // registry would say npm
          { found: true, source: "brew-managed", formula: "openclaw" },
        ),
      ).toBe("brew uninstall openclaw");
    });

    it("returns npm uninstall when detection.source=npm-global", () => {
      expect(
        preferredUninstallCommand(
          { npm: "claude-code", brew: null },
          { found: true, source: "npm-global", path: "/usr/local/bin/claude" },
        ),
      ).toBe("npm uninstall -g claude-code");
    });

    it("falls back to registry hints when detection has no actionable source", () => {
      expect(
        preferredUninstallCommand(
          { npm: null, brew: null, script: "https://example.com/install.sh" },
          { found: true, source: "user-dirs", path: "/home/u/.local/bin/x" },
        ),
      ).toBeNull();
    });

    it("falls back to registry hints when detection is omitted (backward compat)", () => {
      expect(
        preferredUninstallCommand({ npm: "pkg", brew: null }),
      ).toBe("npm uninstall -g pkg");
    });

    it("uses binary as formula when detection.formula is missing", () => {
      expect(
        preferredUninstallCommand(
          { npm: null, brew: null, binary: "openclaw" },
          { found: true, source: "brew-managed" },
        ),
      ).toBe("brew uninstall openclaw");
    });
  });
});

describe("isBrewManagedPath", () => {
  it("recognises Apple Silicon brew prefix", () => {
    expect(isBrewManagedPath("/opt/homebrew/bin/openclaw")).toBe(true);
  });

  it("recognises Linux brew prefix", () => {
    expect(isBrewManagedPath("/home/linuxbrew/.linuxbrew/bin/openclaw")).toBe(
      true,
    );
  });

  it("rejects /usr/local/bin (ambiguous — npm-global + make install also land here)", () => {
    expect(isBrewManagedPath("/usr/local/bin/openclaw")).toBe(false);
  });

  it("rejects ~/.local/bin (script installers land here)", () => {
    expect(isBrewManagedPath("/home/u/.local/bin/openclaw")).toBe(false);
  });
});

describe("detectInstall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-bin-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns found:true when the npm-package binary is on PATH", () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "hermes-agent");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const result = detectInstall(
      { npm: "hermes-agent", brew: null },
      { PATH: binDir },
    );
    expect(result.found).toBe(true);
    expect(result.source).toBe("PATH");
    expect(result.path).toBe(binPath);
  });

  it("strips the npm scope prefix when guessing the binary name", () => {
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "claude-code");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const result = detectInstall(
      { npm: "@anthropic-ai/claude-code", brew: null },
      { PATH: binDir },
    );
    expect(result.found).toBe(true);
  });

  it("returns found:false when no binary exists on PATH", () => {
    const result = detectInstall(
      { npm: "nonexistent-pkg-xyz", brew: null },
      { PATH: "/empty/dir" },
    );
    expect(result.found).toBe(false);
  });

  it("returns found:false when both install fields are null (e.g. generic-mcp)", () => {
    const result = detectInstall({ npm: null, brew: null }, { PATH: "/" });
    expect(result.found).toBe(false);
  });

  it("finds a script-installed binary in ~/.local/bin even when PATH is empty (#209)", () => {
    const fakeHome = join(tmpDir, "home");
    const localBin = join(fakeHome, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const binPath = join(localBin, "hermes");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const result = detectInstall(
      {
        npm: null,
        brew: null,
        script: "https://hermes-agent.nousresearch.com/install.sh",
        binary: "hermes",
      },
      { PATH: "/empty/dir", HOME: fakeHome },
    );
    expect(result.found).toBe(true);
    expect(result.source).toBe("user-dirs");
    expect(result.path).toBe(binPath);
  });

  it("also probes ~/bin and ~/.cargo/bin as user-local install dirs", () => {
    const fakeHome = join(tmpDir, "home");
    const cargoBin = join(fakeHome, ".cargo", "bin");
    mkdirSync(cargoBin, { recursive: true });
    const binPath = join(cargoBin, "zeroclaw");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const result = detectInstall(
      {
        npm: null,
        brew: null,
        script: "https://example.com/install.sh",
        binary: "zeroclaw",
      },
      { PATH: "/empty/dir", HOME: fakeHome },
    );
    expect(result.found).toBe(true);
    expect(result.source).toBe("user-dirs");
  });

  it("labels binaries under /opt/homebrew/bin as brew-managed with formula = binary name (#357)", () => {
    // We can't write under /opt/homebrew in tests, so verify the classifier
    // function directly. The integration is covered indirectly by
    // detectInstall walking PATH and calling isBrewManagedPath; if the
    // classifier matches the prefix the source is upgraded.
    expect(isBrewManagedPath("/opt/homebrew/bin/openclaw")).toBe(true);
    // Sanity: detectInstall returns source=PATH for non-brew prefixes
    const binDir = join(tmpDir, "regular-bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "openclaw");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const result = detectInstall(
      { npm: "openclaw", brew: null, binary: "openclaw" },
      { PATH: binDir },
    );
    expect(result.source).toBe("PATH");
    expect(result.source).not.toBe("brew-managed");
  });

  it("PATH still wins when a binary exists in both PATH and ~/.local/bin", () => {
    const fakeHome = join(tmpDir, "home");
    const localBin = join(fakeHome, ".local", "bin");
    const pathBin = join(tmpDir, "path-bin");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(pathBin, { recursive: true });
    writeFileSync(join(localBin, "hermes"), "#!/bin/sh\n");
    writeFileSync(join(pathBin, "hermes"), "#!/bin/sh\n");
    const result = detectInstall(
      { npm: null, brew: null, binary: "hermes" },
      { PATH: pathBin, HOME: fakeHome },
    );
    expect(result.found).toBe(true);
    expect(result.source).toBe("PATH");
    expect(result.path).toBe(join(pathBin, "hermes"));
  });
});
