// ---------------------------------------------------------------------------
// /selfcheck — admin-only config self-check, group-level and in a topic.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { makeHarness, profile, text, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { seeded, replyText } from "./commands.test-helpers.ts";

// ---------------------------------------------------------------------------
// 10 /selfcheck — admin-only config self-check, group-level and in a topic
// ---------------------------------------------------------------------------

describe("/selfcheck (10)", () => {
  it("an admin runs the check at the group's general chat and gets the report", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/selfcheck"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h).some((t) => t.includes("Self-check"))).toBe(true);
  });

  it("an operator is refused", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/selfcheck"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
  });
});