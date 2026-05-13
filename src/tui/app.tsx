import { Box, useApp, useInput, useStdin } from "ink";
import { useState } from "react";
import type { BootInfo } from "./boot-info.js";
import {
  DashboardProvider,
  type DashboardServices,
} from "./dashboard-context.js";
import { ActivityFeed } from "./components/activity-feed.js";
import { AgentList } from "./components/agent-list.js";
import { BootBanner } from "./components/boot-banner.js";
import { StatsPanel } from "./components/stats-panel.js";
import { StatusBar } from "./components/status-bar.js";
import { useLayout } from "./hooks.js";

export interface AppProps {
  bootInfo: BootInfo;
  services: DashboardServices;
}

export function App({ bootInfo, services }: AppProps): JSX.Element {
  return (
    <DashboardProvider {...services}>
      <Shell bootInfo={bootInfo} />
    </DashboardProvider>
  );
}

function Shell({ bootInfo }: { bootInfo: BootInfo }): JSX.Element {
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
      <BootBanner info={bootInfo} />
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
