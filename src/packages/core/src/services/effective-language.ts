// ---------------------------------------------------------------------------
// Effective-language resolution: a stored `/lang` preference wins over the
// Telegram auto-detected language_code. This needs the database port (to read
// the stored preference), so it lives outside the pure texts module. Every
// outbound message to a sender resolves through this so the whole UI speaks
// the language the sender actually chose.
// ---------------------------------------------------------------------------

import type { UserProfile } from "@relaytg/shared";
import type { Database } from "../ports.ts";
import { languageOf, resolveLanguage, type Language } from "./texts.ts";

export async function effectiveLanguageOf(db: Database, profile: UserProfile): Promise<Language> {
  const user = await db.users.getByTelegramUserId(profile.telegramUserId);
  if (user) return languageOf(user);
  return resolveLanguage(profile.languageCode);
}