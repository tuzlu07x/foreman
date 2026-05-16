import { describe, expect, it } from "vitest";
import {
  explain,
  REASON_EXPLANATIONS,
} from "../../src/tui/reason-explanations.js";

describe("reason explanations", () => {
  it("covers every default factor rule id (secret_pattern emits 3 sub-rules)", () => {
    for (const name of [
      "secret_path",
      "secret_shape",
      "safe_list_docs",
      "outbound_network",
      "shell_exec",
      "first_agent_to_agent",
      "previously_denied_pattern",
    ]) {
      expect(REASON_EXPLANATIONS).toHaveProperty(name);
      expect(REASON_EXPLANATIONS[name]).toBeTruthy();
    }
  });

  it("keeps the legacy secret_file_pattern key so pre-#225 audit rows still render prose", () => {
    expect(REASON_EXPLANATIONS).toHaveProperty("secret_file_pattern");
  });

  it("returns undefined for unknown reasons", () => {
    expect(explain("something_else")).toBeUndefined();
  });
});
