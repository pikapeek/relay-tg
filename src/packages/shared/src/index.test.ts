import { describe, expect, it } from "vitest";
import { VERSION } from "./index.ts";

describe("shared placeholder", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
