import { describe, expect, it } from "vitest";
import {
  WELCOME_STEPS,
  totalEstimatedMinutes,
} from "../../src/tui/setup-wizard.js";

describe("WELCOME_STEPS", () => {
  it("lists five steps after #367 added Foreman's brain", () => {
    expect(WELCOME_STEPS).toHaveLength(5);
  });

  it("step names + numbers match the wizard's actual flow", () => {
    expect(WELCOME_STEPS.map((s) => s.name)).toEqual([
      "LLM Providers",
      "Foreman's brain",
      "Agents",
      "Services",
      "Install + Verify",
    ]);
    expect(WELCOME_STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("marks the Services step as optional", () => {
    const services = WELCOME_STEPS.find((s) => s.name === "Services");
    expect(services?.optional).toBe(true);
  });

  it("non-Services steps are not marked optional", () => {
    const required = WELCOME_STEPS.filter((s) => s.name !== "Services");
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
  it("sums the default WELCOME_STEPS to about 9 minutes after #367", () => {
    expect(totalEstimatedMinutes()).toBe(9);
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
