import { describe, expect, it } from "vitest";
import { contentToForm, contentToMethod, inlineKeyboardToJson, singleColumnKeyboard } from "./mapper.ts";

describe("outbound mapper", () => {
  it("maps every MVP content type to its send method", () => {
    expect(contentToMethod({ type: "text", text: "x" })).toBe("sendMessage");
    expect(contentToMethod({ type: "photo", fileId: "f", caption: null, fileSize: null })).toBe("sendPhoto");
    expect(contentToMethod({ type: "video", fileId: "f", caption: null, fileSize: null })).toBe("sendVideo");
    expect(contentToMethod({ type: "document", fileId: "f", caption: null, fileSize: null })).toBe("sendDocument");
    expect(contentToMethod({ type: "audio", fileId: "f", caption: null, fileSize: null })).toBe("sendAudio");
    expect(contentToMethod({ type: "voice", fileId: "f", caption: null, fileSize: null })).toBe("sendVoice");
    expect(contentToMethod({ type: "sticker", fileId: "f", fileSize: null })).toBe("sendSticker");
  });

  it("carries file_id and caption for media", () => {
    expect(contentToForm({ type: "photo", fileId: "f2", caption: "cap", fileSize: 5 })).toEqual({ photo: "f2", caption: "cap" });
    expect(contentToForm({ type: "photo", fileId: "f2", caption: null, fileSize: null })).toEqual({ photo: "f2" });
    expect(contentToForm({ type: "sticker", fileId: "st", fileSize: 1 })).toEqual({ sticker: "st" });
    expect(contentToForm({ type: "text", text: "hi" })).toEqual({ text: "hi" });
  });

  it("builds an inline keyboard payload with callback data", () => {
    const keyboard = singleColumnKeyboard([
      { text: "7", callbackData: "verify:7" },
      { text: "17", callbackData: "verify:17" },
    ]);
    const json = inlineKeyboardToJson(keyboard);
    expect(json).toContain('"inline_keyboard"');
    expect(json).toContain('"text":"7"');
    expect(json).toContain('"callback_data":"verify:7"');
    expect(json).toContain('"callback_data":"verify:17"');
  });
});
