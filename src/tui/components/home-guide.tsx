import { Box, Text } from "ink";
import { type JSX, useEffect, useState } from "react";
import { getForemanPaths } from "../../utils/config.js";
import { useDashboardServices } from "../dashboard-context.js";
import { type HomeFacts, nextSteps, readHomeFacts, teamSummary } from "../home-guide.js";
import { roundBorder, theme } from "../theme.js";

// Home's "Team" line and the setup steps still open (home-guide.ts).

/** Wide enough for the longest step, so the commands line up. */
const STEP_WIDTH = 32;

export function HomeGuide({ width }: { width?: string }): JSX.Element | null {
  const services = useDashboardServices();
  const read = (): HomeFacts =>
    readHomeFacts({
      agents: services.registry.list().length,
      notifyConfigPath: getForemanPaths().notifyConfigPath,
      orgConfigPath: services.orgConfigPath ?? getForemanPaths().orgConfigPath,
      attached: services.attachedGateway !== undefined && services.attachedGateway() !== null,
    });
  const [facts, setFacts] = useState<HomeFacts>(read);
  useEffect(() => {
    const t = setInterval(() => setFacts(read()), 5000);
    return () => clearInterval(t);
  }, [services]);

  const steps = nextSteps(facts);
  const team = teamSummary(facts.org);
  return (
    // Stacked under the Activity feed in a fixed-height page: the guide keeps
    // its lines and the feed gives up rows instead (flexShrink 0).
    <Box width={width} flexDirection="column" borderStyle={roundBorder()} borderDimColor paddingX={1} flexShrink={0}>
      <Text color={theme.accent.primary}>Team</Text>
      <Text wrap="truncate-end" color={team ? theme.fg.default : theme.fg.muted}>
        {facts.orgBroken ? "org.yaml doesn't parse (foreman org validate)" : (team ?? "no team yet")}
        <Text color={theme.fg.muted}> · t</Text>
      </Text>
      {steps.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent.primary}>Next steps</Text>
          {steps.map((s) => (
            <Text key={s.text} wrap="truncate-end">
              {theme.symbols.bullet} {s.text.padEnd(STEP_WIDTH)}
              <Text color={theme.fg.muted}>{s.how}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
