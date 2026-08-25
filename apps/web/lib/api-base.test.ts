import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveApiBase } from "./api-base.js";

describe("resolveApiBase", () => {
  it("uses the /api prefix in the browser so Next.js pages are not stolen by the API", () => {
    assert.equal(resolveApiBase({ isBrowser: true, publicUrl: "same-origin" }), "/api");
    assert.equal(resolveApiBase({ isBrowser: true, publicUrl: "/" }), "/api");
  });

  it("keeps localhost for local Next.js when no public URL is set", () => {
    assert.equal(resolveApiBase({ isBrowser: true }), "http://localhost:4000");
  });

  it("uses the internal API URL on the server even when the browser is same-origin", () => {
    assert.equal(
      resolveApiBase({
        isBrowser: false,
        publicUrl: "same-origin",
        internalUrl: "http://api:4000",
      }),
      "http://api:4000",
    );
  });
});
