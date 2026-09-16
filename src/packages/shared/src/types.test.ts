import { describe, expect, it } from "vitest";
import { displayName } from "./types.ts";

describe("shared domain types", () => {
  it("has no status field on the conversation record shape", () => {
    const conversation: Record<string, unknown> = {
      id: "c1",
      telegramUserId: 1,
      telegramTopicId: 42,
      assignedOperatorId: null,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      hiddenAt: null,
      hideAfterHours: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(conversation).not.toHaveProperty("status");
    expect(conversation).not.toHaveProperty("closed_at");
    expect(conversation).toHaveProperty("hiddenAt");
    expect(conversation).toHaveProperty("hideAfterHours");
  });

  it("derives a display name from profile without sensitive content", () => {
    expect(displayName({ telegramUserId: 123, firstName: "Jason", username: "jason", lastName: null, languageCode: "en", isBot: false })).toBe("Jason");
    expect(displayName({ telegramUserId: 123, firstName: null, username: "jason", lastName: null, languageCode: "en", isBot: false })).toBe("jason");
    expect(displayName({ telegramUserId: 123, firstName: null, username: null, lastName: null, languageCode: "en", isBot: false })).toBe("123");
  });
});
