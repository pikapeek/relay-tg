// ---------------------------------------------------------------------------
// /ad — runtime ad-keyword management (广告防护): keyword/allowlist/link-rule
// CRUD persisted in settings, plus /ad restore for the quarantine topic.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { makeHarness, profile, text, userMessage, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { seeded, replyText } from "./commands.test-helpers.ts";

// ---------------------------------------------------------------------------
// /ad — runtime ad-keyword management (广告防护)
// ---------------------------------------------------------------------------

describe("/ad (广告防护)", () => {
  it("lists, adds, and deletes runtime keywords (persisted in settings)", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adEmpty);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad add 加微信"), null));
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").adAdded("加微信"));
    expect(await h.db.settings.get("ad_keywords")).toBe("加微信");

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad list"), null));
    expect(replyText(h).some((t) => t.startsWith(OPERATOR_TEXTS("en").adListHeader(1)))).toBe(true);
    expect(replyText(h).some((t) => t.includes("加微信"))).toBe(true);

    await services.processor.process(4, operatorMessage(GROUP_ID, 4, profile(111), text("/ad del 加微信"), null));
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").adRemoved("加微信"));
    expect(await h.db.settings.get("ad_keywords")).toBe("");
  });

  it("a newly added keyword immediately flags messages in the pipeline", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad add 代购"), null));

    const result = await services.processor.process(2, userMessage(42, 100, profile(42), text("海外代购直邮")));
    expect(result.status).toBe("message_rejected");
  });

  it("refuses a non-admin", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/ad add 加微信"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
    expect(await h.db.settings.get("ad_keywords")).toBeNull();
  });

  it("manages the allowlist with /ad allow (list/add/del)", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad allow add 官网"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adAllowAdded("官网"));
    expect(await h.db.settings.get("ad_allow_keywords")).toBe("官网");

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad allow list"), null));
    expect(replyText(h).some((t) => t.startsWith(OPERATOR_TEXTS("en").adAllowListHeader(1)))).toBe(true);

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad allow del 官网"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adAllowRemoved("官网"));
    expect(await h.db.settings.get("ad_allow_keywords")).toBe("");
  });

  it("sets, views, and clears the link rule with /ad links", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad links"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksOff);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad links 3"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksSet("3"));
    expect(await h.db.settings.get("ad_max_links")).toBe("3");

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad links"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksCurrent(3));

    await services.processor.process(4, operatorMessage(GROUP_ID, 4, profile(111), text("/ad links off"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksSet("off"));
    expect(await h.db.settings.get("ad_max_links")).toBe("0");
  });

  it("refuses a non-admin and a reply-less /ad restore", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/ad restore"), null, 9001));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad restore"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adRestoreUsage);
  });
});
