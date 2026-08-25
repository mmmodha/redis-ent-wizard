import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "./theme.js";

describe("resolveTheme", () => {
  it("defaults to dark when the visitor has no stored preference", () => {
    assert.equal(resolveTheme(null), "dark");
    assert.equal(resolveTheme(""), "dark");
    assert.equal(resolveTheme("system"), "dark");
  });

  it("honors an explicit stored light or dark choice", () => {
    assert.equal(resolveTheme("light"), "light");
    assert.equal(resolveTheme("dark"), "dark");
  });
});
