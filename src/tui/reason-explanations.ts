export const REASON_EXPLANATIONS: Record<string, string> = {
  secret_file_pattern:
    "path looks like a credential file (.env / *.key / id_rsa / .aws / .ssh)",
  outbound_network: "tool sends data out over the network",
  shell_exec: "tool runs arbitrary shell commands",
  first_agent_to_agent: "first cross-agent call in the last hour for this pair",
  previously_denied_pattern:
    "a similar request from this source was denied before",
};

export function explain(reason: string): string | undefined {
  return REASON_EXPLANATIONS[reason];
}
