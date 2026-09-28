import { MultiSelect, PasswordInput, Select, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { Key } from "ink";
import type { JSX } from "react";
import {
  findIntegration,
  recommendedVariant,
  type IntegrationEntry,
  type IntegrationVariant,
} from "../../core/integrations/catalog.js";
import type { IntegrationActor } from "../../core/integrations/service.js";
import type { IntegrationWiring } from "../../core/integrations/wiring.js";
import { findCatalogEntry } from "../../core/mcp-hub/catalog.js";
import type { AccessLevelId } from "../../core/mcp-hub/config.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { osc8 } from "../osc8.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import {
  applyCredentialSubmit,
  applyIntegrationsPickerSubmit,
  buildWizardAddInput,
  configuredIntegrationIds,
  credentialFields,
  describeWizardAccess,
  freshDraft,
  integrationPickerOptions,
  nextCommand,
  nextStage,
  paramProblem,
  pendingIntegrations,
  wizardAccess,
  type IntegrationDraft,
  type IntegrationResult,
  type PickerOption,
} from "./integrations-logic.js";
import { stepProgress } from "./progress.js";

// Step 5 — Integrations (optional): picker → per integration: params (when
// the server takes any) → access level → credentials (token variants) →
// saved disabled → summary. OAuth variants sign in after setup; the wizard
// never opens a browser or connects to anything here. See
// docs/plans/integrations.md §7.

const WIZARD: IntegrationActor = { via: "wizard" };

type PickerView =
  | { kind: "unavailable"; reason: string }
  | { kind: "none-left"; configured: string[] }
  | { kind: "list"; options: PickerOption[]; configured: string[] };

function pickerView(wiring: IntegrationWiring | undefined): PickerView {
  if (!wiring) {
    return { kind: "unavailable", reason: "the bundled integration catalog could not be loaded" };
  }
  try {
    const catalog = wiring.catalogs.integrations;
    const configured = configuredIntegrationIds(wiring.service.config(), catalog);
    const options = integrationPickerOptions(catalog, configured);
    const names = configured.map((id) => findIntegration(catalog, id)?.name ?? id);
    return options.length > 0 ? { kind: "list", options, configured: names } : { kind: "none-left", configured: names };
  } catch (err) {
    return { kind: "unavailable", reason: `mcp.yaml can't be read (${describe(err)})` };
  }
}

interface Current {
  wiring: IntegrationWiring;
  entry: IntegrationEntry;
  variant: IntegrationVariant;
  draft: IntegrationDraft;
}

function current(ctx: WizardContext): Current | null {
  const wiring = ctx.services.integrations;
  const id = ctx.state.integrationQueue[ctx.state.integrationIdx];
  if (!wiring || !id) return null;
  const entry = findIntegration(wiring.catalogs.integrations, id);
  if (!entry) return null;
  const variant = recommendedVariant(entry);
  const draft = ctx.state.integrationDraft ?? freshDraft(variant, wiring.catalogs.mcp);
  return { wiring, entry, variant, draft };
}

/** Configure the queue entry at `idx`, or show the summary after the last. */
function moveTo(ctx: WizardContext, idx: number): void {
  const { set } = ctx;
  const wiring = ctx.services.integrations;
  const id = ctx.state.integrationQueue[idx];
  const entry = wiring && id ? findIntegration(wiring.catalogs.integrations, id) : null;
  set.setIntegrationsWarning(null);
  if (!wiring || !entry) {
    set.setIntegrationDraft(null);
    set.setIntegrationsPhase("summary");
    return;
  }
  set.setIntegrationIdx(idx);
  set.setIntegrationDraft(freshDraft(recommendedVariant(entry), wiring.catalogs.mcp));
  set.setIntegrationsPhase("configure");
}

function finish(ctx: WizardContext, result: IntegrationResult): void {
  ctx.set.setIntegrationResults((prev) => [...prev.filter((r) => r.id !== result.id), result]);
  moveTo(ctx, ctx.state.integrationIdx + 1);
}

async function save(ctx: WizardContext, cur: Current, draft: IntegrationDraft): Promise<void> {
  const { wiring, entry, variant } = cur;
  const store = ctx.services.secretStore;
  const oauth = variant.auth.kind === "oauth";
  const { input, rotate } = buildWizardAddInput(
    entry,
    variant,
    draft,
    wizardAccess(ctx.state.agentsSelected),
    (name) => store.exists(name),
  );
  // The typed credential leaves wizard state now; only the store keeps it.
  ctx.set.setIntegrationDraft(null);
  ctx.set.setIntegrationsPhase("saving");
  const base = { id: entry.id, oauth };
  let added: string;
  try {
    added = (await wiring.service.add(input, WIZARD)).name;
  } catch (err) {
    finish(ctx, { ...base, name: entry.name, server: null, outcome: "failed", detail: describe(err) });
    return;
  }
  let detail: string | null = null;
  for (const [slot, value] of Object.entries(rotate)) {
    try {
      await wiring.service.rotateSecret(added, slot, value, WIZARD);
    } catch (err) {
      detail = `kept the stored ${slot}: ${describe(err)}`;
    }
  }
  finish(ctx, { ...base, name: entry.name, server: added, outcome: "saved", detail });
}

function skip(ctx: WizardContext, cur: Current, why: string): void {
  finish(ctx, {
    id: cur.entry.id,
    name: cur.entry.name,
    server: null,
    outcome: "skipped",
    oauth: cur.variant.auth.kind === "oauth",
    detail: why,
  });
}

/** The draft's current stage is done: the next stage, or save. */
function stageDone(ctx: WizardContext, cur: Current, draft: IntegrationDraft): void {
  const next = nextStage(cur.variant, cur.wiring.catalogs.mcp, draft.stage);
  ctx.set.setIntegrationsWarning(null);
  if (next) ctx.set.setIntegrationDraft({ ...draft, stage: next });
  else void save(ctx, cur, draft);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderIntegrationsStep(ctx: WizardContext): JSX.Element {
  const { integrationsPhase } = ctx.state;
  if (integrationsPhase === "configure") {
    const cur = current(ctx);
    if (cur) return renderConfigure(ctx, cur);
  }
  if (integrationsPhase === "saving") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress {...stepProgress("integrations")} label="Integrations" phase="saving" />
        <Spinner label="Saving (disabled until you review it)…" />
      </Box>
    );
  }
  if (integrationsPhase === "summary") return renderSummary(ctx);
  return renderPicker(ctx);
}

function renderPicker(ctx: WizardContext): JSX.Element {
  const view = pickerView(ctx.services.integrations);
  const header = <WizardProgress {...stepProgress("integrations")} label="Integrations" phase="optional" />;
  const footer = (
    <Text color={theme.fg.muted}>
      Add or change integrations any time: the Integrations page (i) or{" "}
      <Text bold>foreman integrations add {"<id>"}</Text>.
    </Text>
  );
  if (view.kind !== "list") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {header}
        {view.kind === "unavailable" ? (
          <Text color={theme.accent.warning}>
            {theme.symbols.warn} Integrations can't be set up here: {view.reason}.
          </Text>
        ) : (
          <Text color={theme.fg.muted}>Already set up: {view.configured.join(", ")}.</Text>
        )}
        {footer}
        <Text color={theme.fg.muted}>[Enter] continue · [Esc] back to services</Text>
      </Box>
    );
  }
  const { integrationsSelected } = ctx.state;
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      {header}
      <Text color={theme.fg.muted}>
        Let your agents work with GitHub, GitLab, Jira and the rest through
        Foreman: every call is checked against your policy. Each one is
        saved <Text bold>off</Text> until you review its tools after setup.
        Skippable — leave empty + Enter.
      </Text>
      {view.configured.length > 0 && (
        <Text color={theme.fg.muted}>Already set up: {view.configured.join(", ")}</Text>
      )}
      <MultiSelect
        options={view.options}
        visibleOptionCount={view.options.length}
        defaultValue={integrationsSelected.filter((id) => view.options.some((o) => o.value === id))}
        onSubmit={(values) => {
          const result = applyIntegrationsPickerSubmit(values, ctx.state.integrationsSelected);
          if (result.kind === "skip") {
            ctx.advance("integrations");
            return;
          }
          ctx.set.setIntegrationsSelected(result.selected);
          ctx.set.setIntegrationQueue(result.queue);
          ctx.set.setIntegrationIdx(0);
          const first = findIntegration(ctx.services.integrations!.catalogs.integrations, result.queue[0]!);
          ctx.set.setIntegrationDraft(
            first ? freshDraft(recommendedVariant(first), ctx.services.integrations!.catalogs.mcp) : null,
          );
          ctx.set.setIntegrationsWarning(null);
          ctx.set.setIntegrationsPhase("configure");
        }}
      />
      <Text color={theme.fg.muted}>[Space] toggle · [Enter] continue · [Esc] back to services</Text>
    </Box>
  );
}

function renderConfigure(ctx: WizardContext, cur: Current): JSX.Element {
  const { entry, variant, draft, wiring } = cur;
  const { integrationIdx, integrationQueue, integrationsWarning } = ctx.state;
  const stageLabel =
    draft.stage === "params" ? "details" : draft.stage === "level" ? "access level" : "credentials";
  const warning = integrationsWarning ? (
    <Text color={theme.accent.warning}>
      {theme.symbols.warn} {integrationsWarning}
    </Text>
  ) : null;
  const frame = (body: JSX.Element): JSX.Element => (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        {...stepProgress("integrations")}
        label="Integrations"
        phase={`${entry.name} (${integrationIdx + 1} of ${integrationQueue.length}) ${theme.symbols.bullet} ${stageLabel}`}
      />
      {body}
      {warning}
      <Text color={theme.fg.muted}>[Enter] continue · [Esc] back to selection</Text>
    </Box>
  );

  if (draft.stage === "params") {
    const specs = findCatalogEntry(wiring.catalogs.mcp, variant.server)?.user_params ?? [];
    const spec = specs[draft.paramIdx];
    if (!spec) return frame(<Text>…</Text>);
    return frame(
      <Box flexDirection="column">
        <Text>
          {spec.label} <Text color={theme.fg.muted}>(e.g. {spec.example})</Text>
        </Text>
        <TextInput
          key={`param:${entry.id}:${spec.name}`}
          defaultValue={spec.default ?? ""}
          onSubmit={(raw) => {
            const value = raw.trim() || spec.default || "";
            const problem = paramProblem(spec, value);
            if (problem) {
              ctx.set.setIntegrationsWarning(problem);
              return;
            }
            const next = { ...draft, params: { ...draft.params, [spec.name]: value } };
            if (draft.paramIdx + 1 < specs.length) {
              ctx.set.setIntegrationsWarning(null);
              ctx.set.setIntegrationDraft({ ...next, paramIdx: draft.paramIdx + 1 });
            } else {
              stageDone(ctx, cur, next);
            }
          }}
        />
      </Box>,
    );
  }

  if (draft.stage === "level") {
    const access = wizardAccess(ctx.state.agentsSelected);
    return frame(
      <Box flexDirection="column">
        <Text>
          Add <Text bold color={theme.accent.primary}>{entry.name}</Text>{" "}
          <Text color={theme.fg.muted}>({variant.label})</Text>
        </Text>
        <Text color={theme.fg.muted}>
          Read-only denies every write tool; read-write lets writes through to your approval.
        </Text>
        <Text color={theme.fg.muted}>
          Who can use it: {describeWizardAccess(access)}
        </Text>
        {variant.auth.kind === "oauth" && (
          <Text color={theme.fg.muted}>
            Signs in through your browser after setup:{" "}
            <Text bold>{nextCommand(entry.id, true)}</Text>
          </Text>
        )}
        <Select
          key={`level:${entry.id}`}
          options={[
            { label: "read-only (recommended)", value: "read-only" },
            { label: "read-write", value: "read-write" },
          ]}
          onChange={(value) => stageDone(ctx, cur, { ...draft, accessLevel: value as AccessLevelId })}
        />
      </Box>,
    );
  }

  const fields = credentialFields(variant, wiring.catalogs.mcp);
  const field = fields[draft.credIdx];
  if (!field) return frame(<Text>…</Text>);
  const stored = ctx.services.secretStore.exists(field.secret);
  const onSubmit = (raw: string): void => {
    const result = applyCredentialSubmit(draft, fields, raw, stored);
    if (result.kind === "skip") {
      skip(ctx, cur, `no ${field.label}`);
    } else if (result.kind === "invalid") {
      ctx.set.setIntegrationsWarning(result.problem);
      ctx.set.setIntegrationDraft({ ...draft, attempt: draft.attempt + 1 });
    } else if (result.done) {
      stageDone(ctx, cur, result.draft);
    } else {
      ctx.set.setIntegrationsWarning(null);
      ctx.set.setIntegrationDraft(result.draft);
    }
  };
  const inputKey = `cred:${entry.id}:${draft.credIdx}:${draft.attempt}`;
  return frame(
    <Box flexDirection="column">
      <Text>
        {theme.symbols.bullet} <Text bold color={theme.accent.primary}>{field.label}</Text>
        {field.formatHint ? <Text color={theme.fg.muted}> — {field.formatHint}</Text> : null}
      </Text>
      {field.whereToGet ? (
        <Text color={theme.fg.muted}>
          Get it at: <Text color={theme.accent.primary}>{osc8(field.whereToGet)}</Text>
        </Text>
      ) : null}
      {field.setupSteps.map((line, i) => (
        <Text key={i} color={theme.fg.muted}>
          {"  "}
          {i + 1}. {line}
        </Text>
      ))}
      <Text color={theme.fg.muted}>
        {stored
          ? "(already stored — Enter on empty input keeps it · type a new value to replace it)"
          : `(Enter to save · Enter on empty input skips ${entry.name})`}
      </Text>
      {field.kind === "username" ? (
        <TextInput key={inputKey} onSubmit={onSubmit} />
      ) : (
        <PasswordInput key={inputKey} placeholder="paste it here — never shown" onSubmit={onSubmit} />
      )}
    </Box>,
  );
}

function renderSummary(ctx: WizardContext): JSX.Element {
  const results = ctx.state.integrationResults;
  const saved = results.filter((r) => r.outcome === "saved");
  const skipped = results.filter((r) => r.outcome === "skipped");
  const failed = results.filter((r) => r.outcome === "failed");
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress {...stepProgress("integrations")} label="Integrations" phase="summary" />
      {saved.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.accent.success}>
            ✓ Saved {saved.length} — off until you review {saved.length === 1 ? "it" : "them"} after setup:
          </Text>
          {saved.map((r) => (
            <Box key={r.id} flexDirection="column">
              <Text color={theme.fg.muted}>
                {"  "}• {r.name}
                {"   "}next: <Text bold>{nextCommand(r.server!, r.oauth)}</Text>
              </Text>
              {r.detail ? (
                <Text color={theme.accent.warning}>
                  {"    "}
                  {theme.symbols.warn} {r.detail}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : (
        <Text color={theme.fg.muted}>
          (no integrations added — add them later on the Integrations page, i)
        </Text>
      )}
      {skipped.length > 0 && (
        <Text color={theme.accent.warning}>
          {theme.symbols.warn} Skipped: {skipped.map((r) => `${r.name} (${r.detail})`).join(", ")}
        </Text>
      )}
      {failed.map((r) => (
        <Text key={r.id} color={theme.accent.danger}>
          ✗ {r.name} was not saved: {r.detail}
        </Text>
      ))}
      <Text color={theme.fg.muted}>[Enter] continue · [Esc] back to selection</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Done screen block
// ---------------------------------------------------------------------------

/** Integrations this setup added that are still off, with the command to
 *  run next. Null when there are none. */
export function renderIntegrationsNextSteps(ctx: WizardContext): JSX.Element | null {
  const wiring = ctx.services.integrations;
  if (!wiring || ctx.state.integrationsSelected.length === 0) return null;
  let pending;
  try {
    pending = pendingIntegrations(
      wiring.service.config(),
      wiring.catalogs.integrations,
      ctx.state.integrationsSelected,
    );
  } catch {
    return null;
  }
  if (pending.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold>Integrations — off until you review them</Text>
      {pending.map((p) => (
        <Text key={p.name} color={theme.fg.muted}>
          {"  "}
          <Text color={theme.accent.primary}>▸ {p.command}</Text>
          {"  "}({p.label}
          {p.oauth ? ": sign in, then review" : ""}; then{" "}
          foreman integrations enable {p.name})
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Where Esc from the step after Integrations lands: the summary when
 *  something was done in this pass, else the picker. */
export function backToIntegrations(ctx: WizardContext): void {
  ctx.uncomplete("integrations");
  ctx.set.setIntegrationsWarning(null);
  ctx.set.setIntegrationDraft(null);
  ctx.set.setIntegrationsPhase(ctx.state.integrationResults.length > 0 ? "summary" : "picker");
}

export function handleIntegrationsInput(ctx: WizardContext, _input: string, key: Key): boolean {
  if (ctx.currentStep !== "integrations") return false;
  const { integrationsPhase } = ctx.state;
  const { set } = ctx;
  if (key.escape) {
    if (integrationsPhase === "saving") return true;
    if (integrationsPhase === "configure" || integrationsPhase === "summary") {
      set.setIntegrationDraft(null);
      set.setIntegrationQueue([]);
      set.setIntegrationIdx(0);
      set.setIntegrationsWarning(null);
      set.setIntegrationsPhase("picker");
      return true;
    }
    // picker → the services summary (the step before).
    ctx.uncomplete("services");
    set.setServicesPhase("summary");
    return true;
  }
  if (key.return) {
    if (integrationsPhase === "summary") {
      ctx.advance("integrations");
      return true;
    }
    // Picker without a list (nothing left to add, or unavailable): Enter
    // continues. With a list, the MultiSelect owns Enter.
    if (integrationsPhase === "picker" && pickerView(ctx.services.integrations).kind !== "list") {
      ctx.advance("integrations");
      return true;
    }
  }
  return true;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
