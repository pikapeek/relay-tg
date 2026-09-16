// Wrangler exposes `?raw` imports for non-JS assets (migrations/*.sql here).
// This ambient declaration lets tsc type-check those imports; vitest resolves
// them at runtime.
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}