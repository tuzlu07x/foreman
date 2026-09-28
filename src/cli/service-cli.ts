import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Command } from "commander";
import { trustedDaemonFiles } from "../core/daemon/client.js";
import { daemonFiles, MAX_SOCKET_PATH } from "../core/daemon/protocol.js";
import {
  installService,
  installedServiceFile,
  readInstalledService,
  SERVICE_LABEL,
  ServiceError,
  serviceEnvironment,
  serviceManagerFor,
  serviceProgram,
  serviceRunning,
  SYSTEMD_UNIT,
  systemRunner,
  uninstallService,
  type ServiceContext,
} from "../core/service.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";

// =============================================================================
// foreman service install | uninstall | status
// =============================================================================
//
// Runs `foreman daemon --service` in the background at login, so agents and
// the PreToolUse hook have the daemon without a terminal open. See
// src/core/service.ts and docs/mcp-hub.md#one-daemon-for-every-agent.

function context(): ServiceContext {
  const manager = serviceManagerFor();
  if (!manager) {
    const why =
      process.platform === "win32"
        ? "native Windows has no daemon (it needs Unix sockets); under WSL2, run `foreman service install` there"
        : `${process.platform} has no supported service manager`;
    throw new ServiceError(`\`foreman service\` isn't supported here: ${why}. Run \`foreman daemon\` yourself if you want it.`);
  }
  return {
    manager,
    home: homedir(),
    stateDir: getForemanPaths().stateDir,
    uid: process.getuid?.() ?? 0,
    run: systemRunner(),
  };
}

function managerName(ctx: ServiceContext): string {
  return ctx.manager === "launchd" ? `launchd (${SERVICE_LABEL})` : `systemd --user (${SYSTEMD_UNIT})`;
}

function logHint(ctx: ServiceContext, logPath: string | null): string {
  return logPath ?? (ctx.manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : "(none)");
}

function run(action: () => void): void {
  try {
    action();
  } catch (err) {
    process.stderr.write(red("error: ") + `${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export const serviceCommand = new Command("service").description(
  "Run Foreman's daemon in the background at login (a LaunchAgent on macOS, a systemd user unit on Linux / WSL2)",
);

serviceCommand
  .command("install")
  .description("Install and start the background service (run it again after upgrading Node or moving Foreman)")
  .action(() => {
    run(() => {
      const ctx = context();
      const paths = getForemanPaths();
      if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
        throw new ServiceError(`Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`);
      }
      const { socketPath } = daemonFiles(paths.stateDir);
      if (socketPath.length > MAX_SOCKET_PATH) {
        throw new ServiceError(
          `the daemon can't run with this state directory: its socket path is ${socketPath.length} characters ` +
            `(the limit is ${MAX_SOCKET_PATH}). Use a shorter FOREMAN_HOME.`,
        );
      }
      const program = serviceProgram({ execPath: process.execPath, argv1: process.argv[1] });
      const result = installService(ctx, program, serviceEnvironment(process.env, ctx.manager));
      console.log(`${green("✓")} ${result.replaced ? "reinstalled" : "installed"} the Foreman daemon service — ${managerName(ctx)}`);
      console.log(`  file     ${result.file}`);
      console.log(`  runs     ${result.program.join(" ")}`);
      console.log(`  home     ${paths.root}`);
      console.log(`  log      ${logHint(ctx, result.logPath)}`);
      console.log(dim(`  loaded with ${result.loadedWith}. Check it with \`foreman service status\`.`));
      console.log(
        dim("  `foreman start` uses this daemon while it runs; run `foreman service install` again after upgrading Node or Foreman."),
      );
    });
  });

serviceCommand
  .command("uninstall")
  .description("Stop the background service and remove its file")
  .action(() => {
    run(() => {
      const ctx = context();
      const result = uninstallService(ctx);
      if (!result.removed) {
        console.log(dim(`Not installed (${result.file} doesn't exist).`));
        return;
      }
      if (result.warning) console.log(`${orange("⚠")} ${result.warning}`);
      console.log(`${green("✓")} stopped and removed the Foreman daemon service (${result.file})`);
    });
  });

serviceCommand
  .command("status")
  .description("Is the background service installed and running, what does it run, where does it log")
  .action(() => {
    run(() => {
      const ctx = context();
      const file = installedServiceFile(ctx.manager, ctx.home);
      const { stateDir } = getForemanPaths();
      const { socketPath } = daemonFiles(stateDir);
      const socket = trustedDaemonFiles(stateDir).ok ? `listening at ${socketPath}` : "not listening";
      console.log(`Foreman daemon service — ${managerName(ctx)}`);
      if (!file) {
        console.log(`  installed  no ${dim("(`foreman service install` adds it)")}`);
        console.log(`  daemon     ${socket}`);
        return;
      }
      const installed = readInstalledService(ctx.manager, ctx.home);
      const state = serviceRunning(ctx);
      console.log(`  installed  yes — ${file}`);
      console.log(
        `  running    ${state.running ? green(`yes${state.pid ? ` (pid ${state.pid})` : ""}`) : orange(`no — ${state.detail}`)}`,
      );
      if (installed) {
        console.log(`  runs       ${installed.program.join(" ")}`);
        const script = installed.program[1] === "daemon" ? [] : installed.program.slice(1, 2);
        for (const path of [...installed.program.slice(0, 1), ...script]) {
          if (!existsSync(path)) {
            console.log(`  ${orange("⚠")} ${path} no longer exists — run \`foreman service install\` again`);
          }
        }
        console.log(`  home       ${installed.env.FOREMAN_HOME ?? "default"}`);
      }
      console.log(`  log        ${logHint(ctx, installed?.logPath ?? null)}`);
      console.log(`  daemon     ${socket}`);
    });
  });
