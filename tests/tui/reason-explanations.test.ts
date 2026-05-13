import { describe, expect, it } from "vitest";
import {
  explain,
  REASON_EXPLANATIONS,
} from "../../src/tui/reason-explanations.js";

describe("reason explanations", () => {
  it("covers every default risk rule name", () => {
    for (const name of [
      "secret_file_pattern",
      "outbound_network",
      "shell_exec",
      "first_agent_to_agent",
      "previously_denied_pattern",
    ]) {
      expect(REASON_EXPLANATIONS).toHaveProperty(name);
      expect(REASON_EXPLANATIONS[name]).toBeTruthy();
    }
  });

  it("returns undefined for unknown reasons", () => {
    expect(explain("something_else")).toBeUndefined();
  });
});
