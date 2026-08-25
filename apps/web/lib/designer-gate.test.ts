import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canUseDesignerCanvas, designerLockReason } from "./designer-gate.js";

describe("canUseDesignerCanvas", () => {
  it("blocks the canvas until a valid service account key is selected", () => {
    assert.equal(canUseDesignerCanvas({}), false);
    assert.equal(canUseDesignerCanvas({ credentialsFile: "", credentialValid: true }), false);
    assert.equal(canUseDesignerCanvas({ credentialsFile: "sa.json" }), false);
    assert.equal(canUseDesignerCanvas({ credentialsFile: "sa.json", credentialValid: false }), false);
    assert.equal(canUseDesignerCanvas({ credentialsFile: "sa.json", credentialValid: true }), true);
  });
});

describe("designerLockReason", () => {
  it("tells the user to select a key when none is chosen", () => {
    assert.match(designerLockReason({}), /service account/i);
  });

  it("tells the user the selected key is invalid", () => {
    assert.match(
      designerLockReason({ credentialsFile: "sa.json", credentialValid: false }),
      /invalid/i,
    );
  });

  it("is empty once a valid key is selected", () => {
    assert.equal(designerLockReason({ credentialsFile: "sa.json", credentialValid: true }), "");
  });
});
