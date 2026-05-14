import { describe, expect, it } from "vitest";
import { resolveDirs } from "../../src/utils/config.js";

describe("resolveDirs", () => {
  describe("FOREMAN_HOME override (single-dir mode)", () => {
    it("collapses all dirs onto the override path", () => {
      const dirs = resolveDirs({
        foremanHome: "/tmp/custom-foreman",
        platform: "linux",
        homeDir: "/home/user",
        env: {},
      });
      expect(dirs.configDir).toBe("/tmp/custom-foreman");
      expect(dirs.stateDir).toBe("/tmp/custom-foreman");
      expect(dirs.cacheDir).toBe("/tmp/custom-foreman/cache");
    });
  });

  describe("Linux (XDG)", () => {
    it("uses ~/.config / ~/.local/state / ~/.cache when no XDG_* is set", () => {
      const dirs = resolveDirs({
        platform: "linux",
        homeDir: "/home/dev",
        env: {},
      });
      expect(dirs.configDir).toBe("/home/dev/.config/foreman");
      expect(dirs.stateDir).toBe("/home/dev/.local/state/foreman");
      expect(dirs.cacheDir).toBe("/home/dev/.cache/foreman");
    });

    it("honours XDG_CONFIG_HOME / XDG_STATE_HOME / XDG_CACHE_HOME overrides", () => {
      const dirs = resolveDirs({
        platform: "linux",
        homeDir: "/home/dev",
        env: {
          XDG_CONFIG_HOME: "/tmp/xdg-config",
          XDG_STATE_HOME: "/tmp/xdg-state",
          XDG_CACHE_HOME: "/tmp/xdg-cache",
        },
      });
      expect(dirs.configDir).toBe("/tmp/xdg-config/foreman");
      expect(dirs.stateDir).toBe("/tmp/xdg-state/foreman");
      expect(dirs.cacheDir).toBe("/tmp/xdg-cache/foreman");
    });
  });

  describe("macOS", () => {
    it("uses Library/Application Support + Library/Caches", () => {
      const dirs = resolveDirs({
        platform: "darwin",
        homeDir: "/Users/fatih",
        env: {},
      });
      expect(dirs.configDir).toBe(
        "/Users/fatih/Library/Application Support/foreman",
      );
      expect(dirs.stateDir).toBe(
        "/Users/fatih/Library/Application Support/foreman",
      );
      expect(dirs.cacheDir).toBe("/Users/fatih/Library/Caches/foreman");
    });

    it("ignores XDG_CONFIG_HOME on darwin", () => {
      const dirs = resolveDirs({
        platform: "darwin",
        homeDir: "/Users/fatih",
        env: { XDG_CONFIG_HOME: "/tmp/should-be-ignored" },
      });
      expect(dirs.configDir).not.toContain("should-be-ignored");
    });
  });

  // node:path on POSIX treats Windows-style absolute paths as relative
  // (prepends cwd). The win32 branch of resolveDirs is structurally verified
  // here; the absolute-path equality is exercised on the real Windows runner
  // (when one is added — tracked under #69).
  describe("Windows (structural — runs on any host)", () => {
    it("uses APPDATA / LOCALAPPDATA from env when present", () => {
      const dirs = resolveDirs({
        platform: "win32",
        homeDir: "C:\\Users\\dev",
        env: {
          APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
        },
      });
      expect(dirs.configDir).toContain("AppData\\Roaming");
      expect(dirs.cacheDir).toContain("AppData\\Local");
      expect(dirs.configDir.endsWith("foreman")).toBe(true);
    });

    it("falls back to AppData/Roaming + AppData/Local when env is missing", () => {
      const dirs = resolveDirs({
        platform: "win32",
        homeDir: "C:\\Users\\dev",
        env: {},
      });
      expect(dirs.configDir).toContain("AppData");
      expect(dirs.configDir).toContain("Roaming");
      expect(dirs.cacheDir).toContain("Local");
    });
  });
});
