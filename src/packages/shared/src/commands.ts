// ---------------------------------------------------------------------------
// Command-string helpers shared by every command dispatcher. Pure: no deps.
// ---------------------------------------------------------------------------

/** Strip an optional `@botusername` suffix from a bot command so the form
 *  Telegram suggests in groups / topics (`/close@relaytg_bot`) and the bare
 *  form (`/close`) resolve to the same command. Telegram only routes a
 *  command to the bot it names (privacy mode on), so a bare strip is enough —
 *  the dispatch side owns the authorization check. */
export function normalizeCommand(raw: string): string {
  const at = raw.indexOf("@");
  return at === -1 ? raw : raw.slice(0, at);
}

/** Trim + split a command line into its normalized command and the remaining
 *  args — the shared shape both the user and operator dispatchers parse. */
export function parseCommand(text: string): { cmd: string; args: string[] } {
  const [raw, ...rest] = text.trim().split(/\s+/);
  return { cmd: normalizeCommand(raw ?? ""), args: rest };
}
