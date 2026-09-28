import { Select, Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { type JSX, useEffect, useState } from "react";
import { roundBorder, theme } from "../theme.js";

// A list to pick a model from: the registry's fast / balanced / strongest
// tiers first, then whatever the provider's live model list adds. Used for
// Foreman's own model (Settings, `m`) and an agent's model (Agents, `m`);
// the caller applies the pick through the same `model` command the console
// runs, so it is validated and audited the same way.

export interface ModelOption {
  id: string;
  /** "fast", "balanced", "most capable", or empty for a listed model. */
  hint: string;
}

export interface ModelPickerProps {
  title: string;
  /** Named in the note when the live list can't be fetched. */
  provider?: string;
  current: string | null;
  tiers: ModelOption[];
  /** The provider's live list, when a key is stored (may reject). */
  loadMore?: () => Promise<string[]>;
  /** Offer "back to the default" (agents). */
  allowClear?: boolean;
  onPick: (model: string | null) => void;
  onCancel: () => void;
}

const CLEAR = "__clear__";

export function ModelPicker({ title, provider, current, tiers, loadMore, allowClear, onPick, onCancel }: ModelPickerProps): JSX.Element {
  const [more, setMore] = useState<string[] | null>(loadMore ? null : []);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!loadMore) return;
    let live = true;
    loadMore()
      .then((ids) => live && setMore(ids))
      .catch((err: unknown) => {
        if (!live) return;
        setMore([]);
        setNote(liveListNote(err instanceof Error ? err.message : String(err), provider ?? "the provider"));
      });
    return () => {
      live = false;
    };
  }, [loadMore]);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const options = pickerOptions(tiers, more ?? [], current, allowClear === true);
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.primary}>
      <Text bold>{title}</Text>
      {current && <Text color={theme.fg.muted}>now: {current}</Text>}
      {more === null && <Spinner label="Loading the provider's model list…" />}
      {note && <Text color={theme.fg.muted}>{note}</Text>}
      <Select
        options={options}
        visibleOptionCount={10}
        onChange={(value) => onPick(value === CLEAR ? null : value)}
      />
      <Text color={theme.fg.muted}>[↑↓] choose · [Enter] use it · [Esc] cancel</Text>
    </Box>
  );
}

/** Why only the registry's models are listed, in words (terminal QA: a
 *  bare "fetch failed" with no network). */
export function liveListNote(message: string, provider: string): string {
  if (/abort|timeout|network|fetch failed|ENOTFOUND|ECONNREFUSED|EPERM/i.test(message)) {
    return `couldn't reach ${provider} for its full model list — showing the usual models`;
  }
  const status = message.match(/^HTTP (\d{3})/)?.[1];
  if (status === "401" || status === "403") {
    return `${provider} rejected the stored key (HTTP ${status}) — showing the usual models`;
  }
  return `no full model list (${message}) — showing the usual models`;
}

/** Tiers first (labelled), then the rest of the live list, no duplicates. */
export function pickerOptions(
  tiers: ModelOption[],
  live: string[],
  current: string | null,
  allowClear: boolean,
): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; value: string }> = [];
  const mark = (id: string): string => (id === current ? " ✓" : "");
  for (const t of tiers) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ label: `${t.id}${t.hint ? ` — ${t.hint}` : ""}${mark(t.id)}`, value: t.id });
  }
  for (const id of live) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ label: `${id}${mark(id)}`, value: id });
  }
  if (allowClear) out.push({ label: "back to the default", value: CLEAR });
  return out;
}
