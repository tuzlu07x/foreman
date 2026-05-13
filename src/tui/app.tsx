import { Box, useApp, useInput, useStdin } from "ink";
import { useEffect, useState } from "react";
import type { ApprovalRequest } from "../core/approval.js";
import type { BootInfo } from "./boot-info.js";
import {
  ApprovalModal,
  type ApprovalResolution,
  type ResolvedBy,
} from "./components/approval-modal.js";
import { ActivityFeed } from "./components/activity-feed.js";
import { AgentList } from "./components/agent-list.js";
import { BootBanner } from "./components/boot-banner.js";
import { StatsPanel } from "./components/stats-panel.js";
import { StatusBar } from "./components/status-bar.js";
import {
  DashboardProvider,
  useDashboardServices,
  type DashboardServices,
} from "./dashboard-context.js";
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
  const { bus } = useDashboardServices();
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);

  useEffect(() => {
    return bus.on("approval:requested", (req) => {
      setPendingApproval(req);
    });
  }, [bus]);

  const resolveApproval = (
    resolution: ApprovalResolution,
    resolvedBy: ResolvedBy,
  ): void => {
    if (!pendingApproval) return;
    bus.emit("approval:resolved", {
      requestId: pendingApproval.requestId,
      decision: resolution.decision,
      remember: resolution.remember,
      resolvedBy,
    });
    setPendingApproval(null);
  };

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
          pendingApproval={pendingApproval}
          onResolveApproval={resolveApproval}
        />
      )}
      <BootBanner info={bootInfo} />
      {pendingApproval ? (
        <ApprovalModal request={pendingApproval} onResolve={resolveApproval} />
      ) : (
        <Box flexGrow={1}>{renderPanels(layout)}</Box>
      )}
      <StatusBar quitConfirm={quitConfirm} />
    </Box>
  );
}

interface KeyboardHandlerProps {
  quitConfirm: boolean;
  setQuitConfirm: (v: boolean) => void;
  pendingApproval: ApprovalRequest | null;
  onResolveApproval: (r: ApprovalResolution, by: ResolvedBy) => void;
}

function KeyboardHandler({
  quitConfirm,
  setQuitConfirm,
  pendingApproval,
  onResolveApproval,
}: KeyboardHandlerProps): null {
  const { exit } = useApp();
  useInput((input, key) => {
    if (pendingApproval) {
      if (input === "a") onResolveApproval({ decision: "allowed" }, "user");
      else if (input === "A")
        onResolveApproval({ decision: "allowed", remember: "allow" }, "user");
      else if (input === "d") onResolveApproval({ decision: "denied" }, "user");
      else if (input === "D")
        onResolveApproval({ decision: "denied", remember: "deny" }, "user");
      else if (input === "r")
        onResolveApproval({ decision: "allowed", remember: "allow" }, "user");
      return;
    }
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
