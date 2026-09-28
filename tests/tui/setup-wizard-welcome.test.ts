import { describe, expect, it } from "vitest";
import {
  WELCOME_STEPS,
  totalEstimatedMinutes,
} from "../../src/tui/setup-wizard.js";

describe("WELCOME_STEPS", () => {
  it("lists six steps after the Integrations step was added", () => {
    expect(WELCOME_STEPS).toHaveLength(6);
  });

  it("step names + numbers match the wizard's actual flow", () => {
    expect(WELCOME_STEPS.map((s) => s.name)).toEqual([
      "LLM Providers",
      "Foreman's brain",
      "Agents",
      "Services",
      "Integrations",
      "Install + Verify",
    ]);
    expect(WELCOME_STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("marks the Services and Integrations steps as optional", () => {
    for (const name of ["Services", "Integrations"]) {
      expect(WELCOME_STEPS.find((s) => s.name === name)?.optional).toBe(true);
    }
  });

  it("the other steps are not marked optional", () => {
    const required = WELCOME_STEPS.filter(
      (s) => s.name !== "Services" && s.name !== "Integrations",
    );
    for (const s of required) {
      expect(s.optional).toBeFalsy();
    }
  });

  it("every step has a positive minute estimate", () => {
    for (const s of WELCOME_STEPS) {
      expect(s.estimateMinutes).toBeGreaterThan(0);
    }
  });
});

describe("totalEstimatedMinutes", () => {
  it("sums the default WELCOME_STEPS to about 10 minutes", () => {
    expect(totalEstimatedMinutes()).toBe(10);
  });

  it("sums any subset that's passed in", () => {
    expect(
      totalEstimatedMinutes([
        { number: 1, name: "A", estimateMinutes: 5 },
        { number: 2, name: "B", estimateMinutes: 10 },
      ]),
    ).toBe(15);
  });

  it("returns 0 for an empty list", () => {
    expect(totalEstimatedMinutes([])).toBe(0);
  });
});
