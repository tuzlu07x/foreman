export interface GatewayInfo {
  stdio: boolean;
  wsPort?: number;
}

export interface BootInfo {
  publicKey: Buffer;
  policyRules: number;
  dbPath: string;
  gateway: GatewayInfo;
  version: string;
}

export interface BootLine {
  label: string;
  detail: string;
}

export function buildBootLines(info: BootInfo): BootLine[] {
  return [
    {
      label: "Identity loaded",
      detail: `(ed25519:${fingerprint(info.publicKey)}…)`,
    },
    {
      label: "Policy loaded",
      detail: `(${info.policyRules} ${info.policyRules === 1 ? "rule" : "rules"})`,
    },
    {
      label: "Database ready",
      detail: `(${info.dbPath})`,
    },
    {
      label: "MCP gateway up",
      detail: gatewayDetail(info.gateway),
    },
  ];
}

export function fingerprint(publicKey: Buffer): string {
  return publicKey.subarray(0, 4).toString("hex");
}

export function gatewayDetail(gateway: GatewayInfo): string {
  if (gateway.stdio && gateway.wsPort !== undefined) {
    return `(stdio + ws:${gateway.wsPort})`;
  }
  if (gateway.wsPort !== undefined) return `(ws:${gateway.wsPort})`;
  return "(stdio)";
}
