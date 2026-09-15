import type { AuthUser, Role, TokenScope } from "./auth.js";

/**
 * Machine-to-machine API tokens. These let non-interactive callers (chiefly the
 * MCP server, on behalf of an AI tool) authenticate without Okta. Each token
 * resolves to a real {@link AuthUser} — so ownership, quota, and audit still
 * attribute actions to a principal — carrying a {@link TokenScope} that the
 * route guard enforces (a `define` token is blocked from provisioning).
 *
 * Tokens are configured via the `REW_API_TOKENS` env var, a JSON array:
 *
 *   [
 *     { "token": "rew_ci_...", "sub": "mcp-ci", "email": "mcp@redis.com",
 *       "name": "MCP (CI)", "scope": "define" }
 *   ]
 *
 * `scope` defaults to `define` (least privilege) and `role` to `user`. A token
 * value shorter than 16 chars is rejected so a weak secret can't slip in.
 */
interface RawApiToken {
  token: string;
  sub?: string;
  email?: string;
  name?: string;
  scope?: TokenScope;
  role?: Role;
}

const MIN_TOKEN_LENGTH = 16;

// Cache the parsed map keyed by the raw env string so a changed env (e.g. in
// tests) is re-parsed, while steady-state lookups don't re-parse every request.
let cache: { raw: string; tokens: Map<string, AuthUser> } | undefined;

function parse(raw: string): Map<string, AuthUser> {
  const tokens = new Map<string, AuthUser>();
  const trimmed = raw.trim();
  if (!trimmed) return tokens;

  let entries: RawApiToken[];
  try {
    const parsed = JSON.parse(trimmed);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("REW_API_TOKENS is not valid JSON (expected an array of token objects)");
  }

  for (const entry of entries) {
    if (!entry || typeof entry.token !== "string") {
      throw new Error("REW_API_TOKENS entry is missing a string `token`");
    }
    if (entry.token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`REW_API_TOKENS token is too short (min ${MIN_TOKEN_LENGTH} chars)`);
    }
    const scope: TokenScope = entry.scope === "full" ? "full" : "define";
    const role: Role = entry.role === "admin" ? "admin" : "user";
    const sub = entry.sub?.trim() || `token:${entry.token.slice(0, 8)}`;
    const email = entry.email?.trim() || `${sub}@tokens.local`;
    tokens.set(entry.token, {
      sub,
      email,
      name: entry.name?.trim() || sub,
      groups: [],
      role,
      scope,
    });
  }
  return tokens;
}

function store(): Map<string, AuthUser> {
  const raw = process.env.REW_API_TOKENS || "";
  if (!cache || cache.raw !== raw) {
    cache = { raw, tokens: parse(raw) };
  }
  return cache.tokens;
}

/** Resolve a bearer token to its principal, or undefined if it isn't an API token. */
export function lookupApiToken(token: string): AuthUser | undefined {
  if (!token) return undefined;
  // Return a fresh copy so callers can't mutate the cached principal.
  const user = store().get(token);
  return user ? { ...user } : undefined;
}
