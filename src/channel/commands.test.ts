import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, COMMANDS, parseCommandInvocation } from "./commands.js";

describe("COMMANDS", () => {
  it("declares every command exactly once, so an adapter can register from this list alone", () => {
    expect(COMMANDS.map((command) => command.name).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it("gives every parameter something an adapter can register it with", () => {
    for (const command of COMMANDS) {
      expect(command.description).not.toBe("");
      expect(command.parameters.length).toBeGreaterThan(0);

      for (const parameter of command.parameters) {
        expect(parameter.name).not.toBe("");
        expect(parameter.description).not.toBe("");
      }
    }
  });

  it("accepts exactly the arguments it declares as required", () => {
    for (const command of COMMANDS) {
      const args = Object.fromEntries(
        command.parameters
          .filter((parameter) => parameter.required)
          .map((parameter) => [parameter.name, "something"]),
      );

      expect(() => parseCommandInvocation(command.name, args)).not.toThrow();
      expect(() => parseCommandInvocation(command.name, {})).toThrow();
    }
  });
});
