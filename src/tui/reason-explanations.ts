// Lookup table for risk factor `rule` strings — the modal / inspect view
// show the prose alongside the rule id so the user understands what fired.
// Keep keys in sync with the rule names emitted in `src/core/risk-rules/*`.
export const REASON_EXPLANATIONS: Record<string, string> = {
  // Secret patterns (#225 / C2) — three sub-rules under one umbrella
  secret_path: "path matches a well-known secret/credential file",
  secret_shape: "args contain a secret-shaped string (API key, JWT, PEM key, …)",
  safe_list_docs: "common docs/config file that looks secret-adjacent",

  // Legacy alias kept so audit rows written before #225 still render prose
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
