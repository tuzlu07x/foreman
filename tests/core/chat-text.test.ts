import { describe, expect, it } from "vitest";
import { isSlashCommand, parseChatCommand } from "../../src/core/chat-text.js";

describe("chat text", () => {
  it("takes a slash word as a command", () => {
    expect(isSlashCommand("/foreman status")).toBe(true);
    expect(isSlashCommand("/start")).toBe(true);
    expect(parseChatCommand("/foreman status")).toEqual(["status"]);
    expect(parseChatCommand("/integrations list")).toEqual(["integrations", "list"]);
    expect(parseChatCommand("/foreman")).toEqual([]);
  });

  it("keeps a message that opens with a path whole", () => {
    const task = "/Users/me/app klasöründeki projeyi yapın";
    expect(isSlashCommand(task)).toBe(false);
    expect(parseChatCommand(task)).toEqual(["/Users/me/app", "klasöründeki", "projeyi", "yapın"]);
    expect(parseChatCommand(`/foreman ${task}`)[0]).toBe("/Users/me/app");
  });

  it("reads plain text as it is", () => {
    expect(isSlashCommand("report me")).toBe(false);
    expect(parseChatCommand("report me")).toEqual(["report", "me"]);
  });
});
