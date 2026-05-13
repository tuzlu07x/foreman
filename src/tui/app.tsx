import { Box, useApp, useInput, useStdin } from "ink";
import { useState } from "react";
import { ActivityFeed } from "./components/activity-feed.js";
import { AgentList } from "./components/agent-list.js";
import { BootBanner } from "./components/boot-banner.js";
import { StatsPanel } from "./components/stats-panel.js";
import { StatusBar } from "./components/status-bar.js";
import { useLayout } from "./hooks.js";

export function App(): JSX.Element {
  const layout = useLayout();
  const { isRawModeSupported } = useStdin();
  const [quitConfirm, setQuitConfirm] = useState(false);

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
        />
      )}
      <BootBanner />
      <Box flexGrow={1}>{renderPanels(layout)}</Box>
      <StatusBar quitConfirm={quitConfirm} />
    </Box>
  );
}

interface KeyboardHandlerProps {
  quitConfirm: boolean;
  setQuitConfirm: (v: boolean) => void;
}

function KeyboardHandler({
  quitConfirm,
  setQuitConfirm,
}: KeyboardHandlerProps): null {
  const { exit } = useApp();
  useInput((input, key) => {
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape)
        setQuitConfirm(false);
      return;
    }
    if (input === "q") exit();
    else if (key.ctrl && input === "c") setQuitConfirm(true);
  });
  return null;
}

function renderPanels(layout: "wide" | "medium" | "narrow"): JSX.Element {
  if (layout === "wide") {
    return (
      <>
        <AgentList width="20%" />
        <ActivityFeed width="60%" />
        <StatsPanel width="20%" />
      </>
    );
  }
  if (layout === "medium") {
    return (
      <Box flexDirection="column" width="100%">
        <AgentList compact />
        <ActivityFeed />
      </Box>
    );
  }
  return <ActivityFeed minimal />;
}
