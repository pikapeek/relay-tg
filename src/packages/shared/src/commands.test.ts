import { describe, expect, it } from "vitest";
import { normalizeCommand, parseCommand } from "./commands.ts";

describe("normalizeCommand", () => {
  it("leaves a bare command untouched", () => {
    expect(normalizeCommand("/close")).toBe("/close");
  });

  it("strips a @botusername suffix", () => {
    expect(normalizeCommand("/close@relaytg_bot")).toBe("/close");
  });

  it("keeps the arguments when the command is split by whitespace", () => {
    const [raw, ...args] = "/hide 48".split(/\s+/);
    expect(normalizeCommand(raw)).toBe("/hide");
    expect(args).toEqual(["48"]);
  });
});

describe("parseCommand", () => {
  it("returns the normalized command and the remaining args", () => {
    expect(parseCommand("/close@relaytg_bot arg1 arg2")).toEqual({ cmd: "/close", args: ["arg1", "arg2"] });
  });

  it("splits on runs of whitespace and trims leading/trailing spaces", () => {
    expect(parseCommand("  /hide  48  ")).toEqual({ cmd: "/hide", args: ["48"] });
  });

  it("yields an empty args array for a bare command", () => {
    expect(parseCommand("/list")).toEqual({ cmd: "/list", args: [] });
  });
});
