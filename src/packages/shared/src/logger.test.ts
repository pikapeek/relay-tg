import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "./logger.ts";

describe("structured logger", () => {
  it("emits timestamp level component event and allowlisted fields", () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger({
      component: "test",
      sink: (l) => lines.push(l),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    logger.info("conversation_created", { conversationId: "c1", telegramUserId: 7 });
    expect(lines[0]).toContain("2026-01-01T00:00:00.000Z");
    expect(lines[0]).toContain("info");
    expect(lines[0]).toContain("[test]");
    expect(lines[0]).toContain("conversation_created");
    expect(lines[0]).toContain('"conversationId":"c1"');
    expect(lines[0]).toContain('"telegramUserId":7');
  });

  it("never interpolates a secret passed as a body field", () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger({ component: "test", sink: (l) => lines.push(l) });
    // Deliberately misuse the API: a secret under a non-allowlisted key.
    logger.info("message_relayed", { telegramUserId: 1, body: "BOTS=main:super-secret-value" } as never);
    const line = lines[0];
    expect(line).not.toContain("super-secret-value");
    expect(line).not.toContain("body");
  });

  it("drops undefined allowlisted fields and respects levels", () => {
    const lines: string[] = [];
    const logger = new ConsoleLogger({ component: "test", level: "warn", sink: (l) => lines.push(l) });
    logger.info("message_relayed", { conversationId: undefined });
    logger.warn("sweep_skip", { topicId: 9 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sweep_skip");
  });
});
