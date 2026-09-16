// ---------------------------------------------------------------------------
// Cloudflare Worker entry (task 12.1). Deliberately thin — /health
// short-circuits, everything else forwards into the single primary DO instance
// (design D5). The `ConversationDO` class is exported here because wrangler
// resolves the binding's `class_name` from this module.
// ---------------------------------------------------------------------------

import { json, type Env } from "./conversation-do.ts";

export { ConversationDO } from "./conversation-do.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Health check short-circuits at the Worker; everything else goes to the
    // single primary DO instance (design D5).
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { status: "ok" });
    }
    const id = env.CONVERSATION.idFromName("primary");
    const stub = env.CONVERSATION.get(id);
    // Read the body here and forward a fresh Request so the DO gets its own
    // independent body stream. (Forwarding the original request object leaves
    // workerd unable to drain the body after the response is sent, and a plain
    // clone() hangs in Miniflare.)
    const body = await request.text();
    return stub.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  },
};