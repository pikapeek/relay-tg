import { describe, expect, it } from "vitest";
import { TEXTS, OPERATOR_TEXTS, resolveLanguage } from "./texts.ts";

describe("resolveLanguage", () => {
  it("maps zh* Telegram language codes to Chinese and everything else to English", () => {
    expect(resolveLanguage("zh")).toBe("zh");
    expect(resolveLanguage("zh-hans")).toBe("zh");
    expect(resolveLanguage("zh-CN")).toBe("zh");
    expect(resolveLanguage("ZH-TW")).toBe("zh");
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("en-US")).toBe("en");
    expect(resolveLanguage(null)).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
  });
});

describe("TEXTS", () => {
  it("builds a bilingual verification question from the same expression", () => {
    const expression = "3 + 5 = ?";
    expect(TEXTS("zh").verifyQuestion(expression)).toContain("点击下面四个答案之一");
    expect(TEXTS("en").verifyQuestion(expression)).toContain("Tap one of the four answers below");
    expect(TEXTS("zh").verifyQuestion(expression)).toContain(expression);
  });
});

describe("OPERATOR_TEXTS", () => {
  it("provides the Chinese approval notice and buttons", () => {
    const t = OPERATOR_TEXTS("zh");
    const notice = t.applyNotice("李雷", 123, "lilei");
    expect(notice).toContain("新的客服申请");
    expect(notice).toContain("姓名：李雷");
    expect(notice).toContain("@lilei");
    expect(t.approveButton).toBe("批准");
    expect(t.rejectButton).toBe("拒绝");
  });

  it("provides the English approval notice and buttons", () => {
    const t = OPERATOR_TEXTS("en");
    const notice = t.applyNotice("Li Lei", 123, "lilei");
    expect(notice).toContain("New support application");
    expect(t.approveButton).toBe("Approve");
    expect(t.rejectButton).toBe("Reject");
  });
});