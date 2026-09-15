import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { lookupApiToken } from "./api-tokens.js";
import { assertScopeAllows } from "./authz.js";
import type { AuthUser } from "./auth.js";

const ORIGINAL = process.env.REW_API_TOKENS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.REW_API_TOKENS;
  else process.env.REW_API_TOKENS = ORIGINAL;
});

const defineUser: AuthUser = {
  sub: "mcp",
  email: "mcp@redis.com",
  name: "MCP",
  groups: [],
  role: "user",
  scope: "define",
};
const fullUser: AuthUser = { ...defineUser, scope: "full" };
const oidcUser: AuthUser = { ...defineUser, scope: undefined };

describe("lookupApiToken", () => {
  it("resolves a configured token to a define-scoped principal", () => {
    process.env.REW_API_TOKENS = JSON.stringify([
      { token: "rew_define_abcdef123456", sub: "mcp-ci", email: "mcp@redis.com", name: "MCP CI" },
    ]);
    const user = lookupApiToken("rew_define_abcdef123456");
    assert.ok(user);
    assert.equal(user?.sub, "mcp-ci");
    assert.equal(user?.email, "mcp@redis.com");
    assert.equal(user?.scope, "define"); // default scope is least-privilege
    assert.equal(user?.role, "user");
  });

  it("honours an explicit full scope and admin role", () => {
    process.env.REW_API_TOKENS = JSON.stringify([
      { token: "rew_full_abcdef123456", sub: "ops", scope: "full", role: "admin" },
    ]);
    const user = lookupApiToken("rew_full_abcdef123456");
    assert.equal(user?.scope, "full");
    assert.equal(user?.role, "admin");
  });

  it("returns undefined for an unknown token", () => {
    process.env.REW_API_TOKENS = JSON.stringify([{ token: "rew_known_abcdef123456" }]);
    assert.equal(lookupApiToken("nope"), undefined);
    assert.equal(lookupApiToken(""), undefined);
  });

  it("returns undefined when no tokens are configured", () => {
    delete process.env.REW_API_TOKENS;
    assert.equal(lookupApiToken("anything"), undefined);
  });

  it("rejects a token that is too short", () => {
    process.env.REW_API_TOKENS = JSON.stringify([{ token: "short" }]);
    assert.throws(() => lookupApiToken("short"), /too short/);
  });

  it("rejects malformed JSON", () => {
    process.env.REW_API_TOKENS = "not json";
    assert.throws(() => lookupApiToken("x"), /not valid JSON/);
  });
});

describe("assertScopeAllows", () => {
  it("permits a define token to read anything", () => {
    assert.doesNotThrow(() => assertScopeAllows(defineUser, "GET", "/instances"));
    assert.doesNotThrow(() => assertScopeAllows(defineUser, "GET", "/instances/x/outputs"));
  });

  it("permits a define token on the define surface", () => {
    for (const path of ["/designs", "/designs/validate", "/designs/render", "/designs/x"]) {
      assert.doesNotThrow(() => assertScopeAllows(defineUser, "POST", path));
    }
  });

  it("refuses a define token on every provisioning/mutating route", () => {
    const blocked: Array<[string, string]> = [
      ["POST", "/instances"],
      ["DELETE", "/instances/x"],
      ["POST", "/instances/bulk-destroy"],
      ["POST", "/instances/x/retry"],
      ["POST", "/instances/x/recreate"],
      ["POST", "/instances/x/forget"],
      ["PATCH", "/instances/x"],
      ["POST", "/preflight"],
      ["POST", "/credentials"],
      ["DELETE", "/credentials/x"],
      ["POST", "/artifacts"],
    ];
    for (const [method, path] of blocked) {
      assert.throws(
        () => assertScopeAllows(defineUser, method, path),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 403,
        `expected 403 for ${method} ${path}`,
      );
    }
  });

  it("never restricts full or OIDC principals", () => {
    for (const user of [fullUser, oidcUser]) {
      assert.doesNotThrow(() => assertScopeAllows(user, "POST", "/instances"));
      assert.doesNotThrow(() => assertScopeAllows(user, "DELETE", "/instances/x"));
    }
  });
});
