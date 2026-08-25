import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusTone, statusToneColor } from "./status-tone.js";

describe("statusTone", () => {
  it("treats ready as a pass so the UI can paint it Volt", () => {
    assert.equal(statusTone("ready"), "pass");
    assert.equal(statusTone("READY"), "pass");
  });

  it("treats live database success the same as ready", () => {
    assert.equal(statusTone("active"), "pass");
    assert.equal(statusTone("applied"), "pass");
  });

  it("treats failed as fail", () => {
    assert.equal(statusTone("failed"), "fail");
  });

  it("leaves in-flight statuses neutral", () => {
    assert.equal(statusTone("bootstrapping"), "neutral");
    assert.equal(statusTone("applying"), "neutral");
  });
});

describe("statusToneColor", () => {
  it("returns Volt for ready instead of muted Dusk", () => {
    assert.equal(statusToneColor("ready"), "var(--status-pass-bg)");
  });

  it("returns Hyper for failed", () => {
    assert.equal(statusToneColor("failed"), "var(--status-fail-bg)");
  });

  it("returns muted text for other statuses", () => {
    assert.equal(statusToneColor("bootstrapping"), "var(--redis-text-secondary)");
  });
});
