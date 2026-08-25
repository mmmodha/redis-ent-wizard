import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canUseDesignerCanvas,
  designerLockReason,
  designHasWorkload,
  designValidateHint,
} from "./designer-gate.js";

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

describe("designHasWorkload", () => {
  it("allows a set of VMs or an application without a Redis cluster", () => {
    assert.equal(designHasWorkload([{ data: { kind: "network" } }]), false);
    assert.equal(designHasWorkload([{ data: { kind: "vms" } }]), true);
    assert.equal(designHasWorkload([{ data: { kind: "application" } }]), true);
    assert.equal(designHasWorkload([{ data: { kind: "cluster" } }]), true);
  });
});

describe("designValidateHint", () => {
  it("asks for an app VM when Redis is turned off and the canvas has no workload", () => {
    assert.match(
      designValidateHint({ hasWorkload: false, redisEnabled: false, mode: "vm" }),
      /set of VMs or an application/i,
    );
  });

  it("asks for a Redis cluster when Redis is included", () => {
    assert.match(
      designValidateHint({ hasWorkload: false, redisEnabled: true, mode: "vm" }),
      /Redis cluster/i,
    );
  });

  it("is silent once something deployable is on the canvas", () => {
    assert.equal(designValidateHint({ hasWorkload: true, redisEnabled: false, mode: "vm" }), "");
  });
});
