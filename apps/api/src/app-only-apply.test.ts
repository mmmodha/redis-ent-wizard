import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vmStackModuleArguments } from "./workspace.js";
import { appWorkloadsSucceeded } from "./progress.js";

describe("vmStackModuleArguments", () => {
  it("passes redis_enabled into the VM profile so app-only deploys skip Redis nodes", () => {
    assert.match(vmStackModuleArguments(), /redis_enabled\s*=\s*var\.redis_enabled/);
  });
});

describe("appWorkloadsSucceeded", () => {
  it("requires the APPWL DONE marker for each named application", () => {
    assert.equal(
      appWorkloadsSucceeded("=== APPWL web DONE ===\n", ["web"]),
      true,
    );
    assert.equal(appWorkloadsSucceeded("Apply complete\n", ["web"]), false);
  });

  it("is true when there are no application workloads to wait for", () => {
    assert.equal(appWorkloadsSucceeded("", []), true);
  });
});
