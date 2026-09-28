import {
  checkSecrets,
  foremanInstallRecord,
  pickMcpConfigPath,
  registerAgent,
} from "../../core/agent-add-flow.js";
import { projectSecretsForAgent } from "../../core/agent-secrets-projector.js";
import {
  detectProviderConflict,
  formatConflictWarning,
} from "../../core/agent-provider-conflict.js";
import {
  detectInstall,
  disableManagedLaunchAgent,
  preferredInstallCommand,
  preferredUninstallCommand,
  runInstall,
  runPostConfigCommands,
  runShell,
  runUninstall,
} from "../../core/agent-install.js";
import {
  checkNodeEngine,
  describeNodeEngineMismatch,
  resolveInstallerNodeVersion,
} from "../../core/node-engines.js";
import { ensureAgentToken, revokeAgentToken } from "../../core/agent-token.js";
import { buildMcpSnippet, snippetForDisplay } from "../../core/agent-mcp-snippet.js";
import { NO_CONFIG_PATH_NOTE, tokenHandoffHint } from "../../core/agent-wiring.js";
import {
  autoRegisterMcp,
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from "../../core/agent-mcp-register-hint.js";
import {
  findAgent,
  loadActiveProviders,
  loadActiveRegistry,
  type AgentEntry,
} from "../../core/registry-catalog.js";
import { applyForemanSoul } from "../../core/foreman-soul.js";
import { getForemanPaths } from "../../utils/config.js";
import { wireAgentConfig } from "./install-config.js";
import { safeFind } from "./shared.js";
import type {
  AgentConfigsMap,
  InstallStepProjectionContext,
  InstallStepSummary,
  OnAgentInstallFailure,
  WizardServices,
} from "./types.js";

/** What happens to an unticked agent's binary (#657). */
export interface RemoveOptions {
  /** Also uninstall the binaries Foreman installed itself. Off by default:
   *  unticking an agent only unregisters it. */
  uninstall?: boolean;
}

// Exported for tests. The wizard's core diff loop: install + register the
// newly-checked agents, unregister the previously-checked-now-unchecked
// ones. Idempotent — running it twice with the same toAdd/toRemove no-ops.
export async function runInstallStep(
  toAdd: string[],
  toRemove: string[],
  services: WizardServices,
  log: (line: string) => void,
  agentConfigs: AgentConfigsMap = {},
  onFailure?: OnAgentInstallFailure,
  projectionCtx: InstallStepProjectionContext = {
    providersSelected: [],
    servicesSelected: [],
  },
  removeOptions: RemoveOptions = {},
): Promise<InstallStepSummary> {
  const summary: InstallStepSummary = {
    registered: [],
    identityPushed: [],
    identitySkipped: [],
    identityNotApplicable: [],
    failed: [],
    removed: [],
    mcpRegisterFailed: [],
    nodeEngineSkipped: [],
    tokenToWire: [],
  };
  const { doc } = loadActiveRegistry();
  // #373 — load provider catalog once so checkSecrets can filter
  // cross-provider required_secrets per the user's per-agent llmProvider.
  const providerCatalog = loadActiveProviders().doc.providers;

  // --- Process unchecks first: remove the row (and, only when asked, the
  // binary Foreman installed) --------------------------------------------
  for (const id of toRemove) {
    const existing = services.registry.get(id);
    if (!existing) continue;
    const registryId =
      typeof existing.metadata?.registryId === "string"
        ? existing.metadata.registryId
        : null;
    const entry = registryId ? safeFind(doc, registryId) : null;
    const installedByForeman = foremanInstallRecord(existing.metadata) !== null;
    log(`▸ Removing ${existing.displayName}`);
    services.registry.remove(id);
    revokeAgentToken(services.secretStore, id);
    summary.removed.push(id);
    log(`  ✓ unregistered "${id}"`);
    if (!removeOptions.uninstall || !installedByForeman) {
      log(
        `  ◦ ${entry?.name ?? existing.displayName} left installed` +
          (removeOptions.uninstall ? " (Foreman didn't install it)" : ""),
      );
    } else if (entry) {
      // #357 — pick uninstall command by *detected* source, not registry
      // hints, so brew-installed binaries (OpenClaw at /opt/homebrew/bin/)
      // actually get `brew uninstall` instead of a silent npm no-op.
      const detection = detectInstall(entry.install);
      const cmd = preferredUninstallCommand(entry.install, detection);
      if (cmd) {
        log(`  uninstalling (${cmd})…`);
        const result = await runUninstall({
          install: entry.install,
          detection,
          onLine: (l) => log(`  ${l}`),
        });
        if (result.ok) log(`  ✓ ${entry.name} uninstalled`);
        else log(`  ⚠ uninstall failed (exit ${result.exitCode}); run manually: ${result.manualCommand}`);
      } else if (entry.install.script) {
        // Script-based installers don't carry an uninstall command; the
        // user has to clean up the binary themselves regardless of shape.
        log(
          `  ⚠ ${entry.name} was installed via a script — remove the ${entry.install.binary ?? id} binary manually.`,
        );
      }
    }
  }

  // --- Then add: install, configure, register ---------------------------
  for (const id of toAdd) {
    let entry: AgentEntry;
    try {
      entry = findAgent(doc, id);
    } catch {
      log(`✗ ${id}: not in registry — skipped`);
      continue;
    }
    log(`▸ ${entry.name}`);

    // Each substep is best-effort — secret-check / config-inject / identity
    // failures degrade to a warning. Binary install can pause for user
    // input via onFailure (#177); register always runs at the end.
    let skipThisAgent = false;
    // Set when Foreman itself ran the installer (#657).
    let installedByForeman: string | undefined;
    while (true) {
      // #458 — Smoke-test the discovered binary so broken shims (the
      // wiped-venv crash QA hit) trigger a reinstall instead of being
      // logged as "already installed".
      const detection = detectInstall(entry.install, process.env, {
        smokeTest: true,
      });
      if (detection.found) {
        log(`  ✓ already installed at ${detection.path}`);
        break;
      }
      if (detection.brokenAt) {
        log(`  ⚠ found broken binary at ${detection.brokenAt} — reinstalling`);
        log(`    ${detection.brokenReason ?? "(no diagnostic)"}`);
      }
      // #646 — The agent needs a newer Node than the one on PATH (OpenClaw:
      // >=24.16.0 <25 || >=26.1.0). Running `npm install -g` would fail
      // halfway, so explain and skip this agent; the rest of the batch
      // continues. The upstream installer is shown, never run.
      const engineMismatch = checkNodeEngine(entry, resolveInstallerNodeVersion);
      if (engineMismatch) {
        const lines = describeNodeEngineMismatch(engineMismatch);
        const [first, ...rest] = lines;
        log(`  ⚠ ${first}`);
        for (const line of rest) log(`  ◦ ${line}`);
        log(`  ✗ ${entry.name} skipped — not registered`);
        summary.failed.push(id);
        summary.nodeEngineSkipped.push({ agentId: id, lines });
        skipThisAgent = true;
        break;
      }
      // #369 — Delegate command construction to the platform-aware
      // picker so Windows users get the PowerShell form and so the
      // wizard log doesn't render `[object Object]` when `script` is
      // an object.
      const installCmd = preferredInstallCommand(entry.install);
      if (!installCmd) {
        // No installer available for this platform — log a manual hint
        // before bailing so the user knows what to do next (WSL2,
        // download page, etc).
        if (process.platform === "win32" && entry.install.script) {
          log(
            `  ⚠ ${entry.name} has no native Windows installer. Run inside WSL2 or install from ${entry.homepage}.`,
          );
        } else {
          log(
            `  ⚠ ${entry.name} has no automated installer for this platform — install manually from ${entry.homepage}.`,
          );
        }
        break;
      }
      log(`  installing (${installCmd})…`);
      const result = await runInstall({
        install: entry.install,
        onLine: (l) => log(`  ${l}`),
      });
      if (result.ok) {
        installedByForeman = installCmd;
        break;
      }
      log(`  ⚠ install failed (exit ${result.exitCode})`);
      log(`    run manually: ${result.manualCommand}`);
      if (!onFailure) break;
      const resolution = await onFailure({
        agentId: id,
        agentName: entry.name,
        stage: "install",
        error: `install command exited with code ${result.exitCode}`,
        manualHint: `Run \`${result.manualCommand}\` from your shell, then re-run \`foreman setup --resume\` to pick up where you left off.`,
      });
      if (resolution === "retry") {
        log(`  ↻ retrying…`);
        continue;
      }
      if (resolution === "skip") {
        log(`  ✗ skipped by user`);
        summary.failed.push(id);
        skipThisAgent = true;
      }
      break;
    }
    if (skipThisAgent) continue;

    // #373 — Pass the user's per-agent llmProvider so checkSecrets drops
    // cross-provider required_secrets (e.g. OpenClaw's anthropic-key when
    // user picked openai). Without this filter, Foreman warns about keys
    // the user doesn't need.
    const secretCheck = checkSecrets(entry, services.secretStore, {
      llmProvider: agentConfigs[id]?.llmProvider,
      providerCatalog,
    });
    if (!secretCheck.hasAllRequired) {
      const missing = secretCheck.required
        .filter((s) => !s.present)
        .map((s) => s.name);
      log(
        `  ⚠ required secrets missing: ${missing.join(", ")} — add via 'foreman secrets add <name>'`,
      );
    }

    // The agent's config file: seed it from the bundled template when
    // missing, then write Foreman's MCP entry (install-config.ts).
    const configRefused = wireAgentConfig(id, entry, services.secretStore, log);

    // Secret projection (#222 / #223) — write Foreman-stored keys to the
    // agent's own env/config files so it launches without a separate setup
    // step. Best-effort: any failure is a warning, not an install abort.
    // Not into a config file just refused for the agent's token (#618): the
    // projector would replace that symlink with a regular file.
    if (configRefused) {
      log(`  ◦ keys not projected either: fix that file, then \`foreman secrets repush ${id}\``);
    } else {
      try {
        // #471 — Mirror the register-time fallback so projection sees the
        // resolved provider for single-compat agents.
        const projCompat = entry.llm_compat ?? [];
        const projProvider =
          agentConfigs[id]?.llmProvider ??
          (projCompat.length === 1 ? projCompat[0] : undefined);
        const projection = projectSecretsForAgent(entry, {
          providersSelected: projectionCtx.providersSelected,
          servicesSelected: projectionCtx.servicesSelected,
          // #389 — per-agent llmProvider so config_overrides' if_provider
          // resolves to the user's per-agent pick (not the global Step 1 set).
          llmProvider: projProvider,
          // #450 — per-agent variant override (e.g. Codex OAuth instead
          // of OpenRouter for Hermes/openai).
          providerVariant: agentConfigs[id]?.providerVariant,
          // #434 — per-agent specific model id chosen in the wizard's
          // model-pick phase; falls back to the variant default when omitted.
          modelVersion: agentConfigs[id]?.modelVersion,
          secretStore: services.secretStore,
          // #426 — Skip channel-tied writes for agents that aren't the
          // primary for a messaging channel.
          chatPrimary: services.chatPrimary,
        });
        for (const f of projection.files) {
          const tag = f.replacedStale ? "⟳ rotated" : f.created ? "✓ wrote" : "✓ updated";
          log(`  ${tag} ${f.secrets.length} secret${f.secrets.length === 1 ? "" : "s"} → ${f.path}`);
        }
        for (const s of projection.skipped) {
          log(`  ◦ skip projection of ${s.secret}: ${s.reason}`);
        }
      } catch (err) {
        log(
          `  ⚠ secret projection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // #350 — provider-config conflict check. Many agents have `provider:`
    // baked into their own config from a previous setup; that value wins
    // over the env vars we just projected. Warn loudly with a fix command
    // so the user doesn't think Foreman is silently broken.
    try {
      const foremanProvider = agentConfigs[id]?.llmProvider;
      if (foremanProvider) {
        const conflict = detectProviderConflict(entry, foremanProvider);
        if (conflict) {
          log(`  ⚠ provider mismatch — Foreman's key won't be used:`);
          for (const line of formatConflictWarning(conflict)) {
            log(`     ${line}`);
          }
        }
      }
    } catch {
      /* best-effort — malformed config files shouldn't block install */
    }

    // #394 — Disable any agent-managed macOS LaunchAgent so Foreman's
    // daemon manager has sole ownership. Hermes' installer drops one
    // that auto-respawns the gateway across reboots; without this
    // disable, two Hermes processes fight for the Telegram bot token.
    // No-op on non-macOS hosts. Idempotent: bootout returns success
    // when not loaded, rename is skipped when already renamed.
    if (entry.install.macos_launch_agent_disable) {
      try {
        const r = await disableManagedLaunchAgent(
          entry.install.macos_launch_agent_disable,
        );
        if (r.platformSkipped) {
          // Don't log — non-macOS users don't need to hear about LaunchAgents.
        } else if (r.plistRenamed) {
          log(
            `  ✓ disabled ${entry.install.macos_launch_agent_disable.label} LaunchAgent (Foreman daemon owns the process now)`,
          );
        } else if (r.bootedOut) {
          log(`  ◦ ${entry.install.macos_launch_agent_disable.label} LaunchAgent already disabled`);
        }
        for (const err of r.errors) {
          log(`  ⚠ ${err}`);
        }
      } catch (err) {
        log(
          `  ⚠ LaunchAgent disable failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // #398 — post-config commands. Run registry-declared shell steps
    // AFTER secrets are projected to the agent's config, so service
    // installers (OpenClaw's `gateway install` LaunchAgent registration)
    // run against valid config. Best-effort — non-zero exits surface
    // as warnings; the daemon manager catches the real failure on next
    // `foreman start` if the gateway still doesn't come up.
    const postCmds = entry.install.post_config_commands ?? [];
    if (postCmds.length > 0) {
      try {
        const results = await runPostConfigCommands(entry.install, (line) =>
          log(`    ${line}`),
        );
        for (const r of results) {
          if (r.ok) {
            log(`  ✓ ${r.command}`);
          } else {
            log(`  ⚠ ${r.command} exited ${r.exitCode}`);
          }
        }
      } catch (err) {
        log(
          `  ⚠ post-config commands failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (services.registry.get(id)) {
      log(`  ◦ already registered`);
      continue;
    }
    try {
      const cfg = agentConfigs[id];
      // #471 — Belt-and-braces fallback: if cfg.llmProvider somehow leaked
      // through unset (e.g. a wizard phase regression) AND the agent has
      // exactly one compatible provider, pick that one. Prevents the silent
      // null-provider state that caused the round-3 "1 of 2 agents" bug.
      const compat = entry.llm_compat ?? [];
      const resolvedProvider =
        cfg?.llmProvider ?? (compat.length === 1 ? compat[0] : undefined);
      registerAgent({
        agentId: id,
        entry,
        registry: services.registry,
        llmProvider: resolvedProvider,
        providerVariant: cfg?.providerVariant,
        modelVersion: cfg?.modelVersion,
        responsibilityNote: cfg?.responsibilityNote,
        installedByForeman,
      });
      summary.registered.push(id);
      log(`  ✓ registered as "${id}"`);
      if (resolvedProvider) log(`    LLM provider: ${resolvedProvider}`);
      if (cfg?.providerVariant) log(`    Provider variant: ${cfg.providerVariant}`);
      if (cfg?.modelVersion) log(`    Model: ${cfg.modelVersion}`);
      if (cfg?.responsibilityNote)
        log(`    Responsibility: ${cfg.responsibilityNote}`);
      // Some agents (Hermes) keep their own MCP server registry CLI-side
      // and don't read the YAML block we injected. #460 — auto-runs the
      // CLI command via `printf 'y\n' | <cmd>` so the user doesn't have
      // to do it manually. Falls back to the manual hint when the run
      // fails (binary missing, prompt won't pipe, etc).
      const registerHint = buildMcpRegisterHint(id, entry, {
        token: ensureAgentToken(services.secretStore, id),
      });
      // #618 — Nowhere to write the token (generic-mcp): say how to fetch
      // it, as `foreman agent add` does. The snippet has a placeholder.
      if (!pickMcpConfigPath(entry) && !registerHint?.wrapper) {
        log(`  ◦ ${NO_CONFIG_PATH_NOTE}`);
        for (const line of snippetForDisplay(buildMcpSnippet(id, entry), null).text.split("\n")) log(`      ${line}`);
        log(`  ◦ ${tokenHandoffHint(id)}`);
        summary.tokenToWire.push(id);
      }
      if (registerHint) {
        // #346 — write the wrapper script for agents (Hermes) that can't
        // accept multi-token --args.
        let wrapperOk = true;
        if (registerHint.wrapper) {
          try {
            const wrote = writeMcpWrapperScript(registerHint.wrapper);
            log(
              `  ${wrote ? "✓ wrote" : "✓ wrapper present"} ${registerHint.wrapper.path}`,
            );
          } catch (err) {
            wrapperOk = false;
            const reason = err instanceof Error ? err.message : String(err);
            log(`  ⚠ wrapper write failed: ${reason}`);
          }
        }
        // Only attempt auto-run when the wrapper is in place (or no
        // wrapper required).
        if (wrapperOk) {
          const autoOutcome = await autoRegisterMcp(registerHint.command, runShell);
          if (autoOutcome.ok) {
            log(`  ✓ registered Foreman MCP with ${entry.name}`);
            if (autoOutcome.firstOutputLine) {
              log(`    ${autoOutcome.firstOutputLine}`);
            }
            if (registerHint.verify) {
              log(`    verify: ${registerHint.verify}`);
            }
          } else {
            log(`  ⚠ auto-register failed (${autoOutcome.error}) — run manually:`);
            if (registerHint.note) log(`    ${registerHint.note}`);
            log(`    $ ${registerHint.command}`);
            if (registerHint.verify) {
              log(`    verify with: ${registerHint.verify}`);
            }
            // #audit-finding-15 — Capture the failure on the summary so
            // the Done screen surfaces it. Agent still runs; without
            // MCP it just can't call Foreman tools.
            summary.mcpRegisterFailed.push({
              agentId: id,
              command: registerHint.command,
              reason: autoOutcome.error ?? "auto-register failed",
            });
          }
        } else {
          // Wrapper write failed — still print the manual fallback.
          log(`  ℹ ${entry.name} needs one extra step to route through Foreman:`);
          if (registerHint.note) log(`     ${registerHint.note}`);
          log(`     $ ${registerHint.command}`);
          summary.mcpRegisterFailed.push({
            agentId: id,
            command: registerHint.command,
            reason: "wrapper script write failed",
          });
        }
      }
      if (entry.identity_path) {
        try {
          // QA round 13: hand applyForemanSoul the agent's responsibility
          // note + sibling agent map so {responsibility} and
          // {peer_agents_block} substitution gets concrete data instead
          // of generic fallbacks. Registry already has all agents
          // registered by this point in the install loop.
          const thisRegistered = services.registry.get(id);
          const peers = services.registry
            .list()
            .filter((a) => a.id !== id)
            .map((a) => ({
              id: a.id,
              displayName: a.displayName,
              responsibilityNote: a.responsibilityNote,
            }));
          const soulResult = applyForemanSoul({
            entry,
            soulPath: getForemanPaths().soulPath,
            responsibilityNote: thisRegistered?.responsibilityNote ?? null,
            peers,
          });
          // QA round 5: applyForemanSoul returns `changed: false` when
          // the agent's identity file already matches the source.
          // That's NOT a failure — the identity IS in place. We used
          // to only count `changed: true` cases, so a re-run / partial
          // wipe (~/.hermes removed but ~/.codex kept) showed
          // "1 of 2 agents pushed" misleadingly. Count any non-null
          // result as success; the log line distinguishes write vs
          // already-current for user clarity.
          if (soulResult) {
            summary.identityPushed.push(id);
            log(
              soulResult.changed
                ? `  ✓ wrote Foreman identity to ${soulResult.path}`
                : `  ◦ Foreman identity already current at ${soulResult.path}`,
            );
          }
        } catch (err) {
          const reason =
            err instanceof Error ? err.message : String(err);
          summary.identitySkipped.push({ agentId: id, reason });
          log(`  ⚠ identity write skipped: ${reason}`);
        }
      } else {
        // No identity file for this agent (generic-mcp): nothing to push,
        // not a failure — Done used to list it under "Identity push failed".
        summary.identityNotApplicable.push(id);
      }
    } catch (err) {
      summary.failed.push(id);
      log(
        `  ✗ register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    log("(no agent changes — selection matches current registration)");
  }

  // QA round 13 — peer-list propagation. During the install loop, each
  // agent's SOUL.md is written with peers = "agents registered SO FAR",
  // which means the FIRST agent installed sees zero peers (it's the only
  // one registered at that moment). Now that all toAdd agents are
  // registered, walk the registry once more and re-apply the soul for
  // every agent with an identity_path. This is idempotent (changed:false
  // when the file already matches), so subsequent runs are no-ops.
  if (toAdd.length > 0) {
    log("");
    log("▸ Refreshing peer awareness across all agents");
    const registered = services.registry.list();
    const allPeers = registered.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      responsibilityNote: a.responsibilityNote,
    }));
    for (const reg of registered) {
      const entry = safeFind(doc, reg.id);
      if (!entry?.identity_path) continue;
      try {
        const peers = allPeers.filter((p) => p.id !== reg.id);
        const r = applyForemanSoul({
          entry,
          soulPath: getForemanPaths().soulPath,
          responsibilityNote: reg.responsibilityNote,
          peers,
        });
        if (r?.changed) {
          log(`  ✓ ${reg.id} — peer list refreshed`);
        }
      } catch (err) {
        log(
          `  ⚠ ${reg.id} — peer refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return summary;
}
