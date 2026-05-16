import { describe, expect, it } from "vitest";
import {
  explain,
  REASON_EXPLANATIONS,
} from "../../src/tui/reason-explanations.js";

describe("reason explanations", () => {
  it("covers every default factor rule id (secret_pattern + network_outbound + shell_command emit sub-rules)", () => {
    for (const name of [
      "secret_path",
      "secret_shape",
      "safe_list_docs",
      "network_exfil_destination",
      "network_paste_share",
      "network_url_shortener",
      "network_ip_literal",
      "network_punycode",
      "network_suspicious_tld",
      "network_mining_pool",
      "network_dark_web",
      "network_safe_host",
      "injection_system_override",
      "injection_smuggling",
      "injection_data_exfil",
      "injection_authority",
      "injection_encoded",
      "loop_pingpong",
      "loop_cycle",
      "loop_burst",
      "loop_token_budget",
      "shell_rm_rf_catastrophic",
      "shell_sudo",
      "shell_persist_crontab",
      "shell_revsh_curl_pipe_bash",
      "shell_evasion_history_clear",
      "shell_recon_etc_shadow",
      "first_agent_to_agent",
      "previously_denied_pattern",
    ]) {
      expect(REASON_EXPLANATIONS).toHaveProperty(name);
      expect(REASON_EXPLANATIONS[name]).toBeTruthy();
    }
  });

  it("keeps the legacy keys so pre-#225/#226/#227 audit rows still render prose", () => {
    expect(REASON_EXPLANATIONS).toHaveProperty("secret_file_pattern");
    expect(REASON_EXPLANATIONS).toHaveProperty("shell_exec");
    expect(REASON_EXPLANATIONS).toHaveProperty("outbound_network");
  });

  it("returns undefined for unknown reasons", () => {
    expect(explain("something_else")).toBeUndefined();
  });
});
