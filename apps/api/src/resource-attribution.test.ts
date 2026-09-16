import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveResource } from "./gcp-inventory.js";
import {
  attributeOne,
  attributeResources,
  nameMatchesInstance,
  summarize,
  UNOWNED,
  type InstanceMeta,
} from "./resource-attribution.js";

function res(name: string, extra: Partial<LiveResource> = {}): LiveResource {
  return { kind: "compute.instance", name, location: "z", attrs: {}, ...extra };
}

describe("nameMatchesInstance", () => {
  it("matches exact id and prefix on a - boundary", () => {
    assert.ok(nameMatchesInstance("demo-default", "demo-default"));
    assert.ok(nameMatchesInstance("demo-default-app", "demo-default"));
    assert.ok(nameMatchesInstance("demo-default-vpc", "demo-default"));
  });

  it("does not match a different id that merely shares a stem", () => {
    // "demo-default" must NOT claim "demo-default2-app" (no dash boundary).
    assert.ok(!nameMatchesInstance("demo-default2-app", "demo-default"));
  });

  it("normalizes BigQuery underscores", () => {
    assert.ok(nameMatchesInstance("demo_default_analytics", "demo-default"));
  });

  it("matches GKE node VM names", () => {
    assert.ok(nameMatchesInstance("gke-demo-default-gke-pool-abc123-xyz", "demo-default"));
  });
});

describe("attributeOne — longest match wins", () => {
  const ids = ["demo", "demo-default"];
  it("prefers the longer instance id", () => {
    assert.equal(attributeOne(res("demo-default-app"), ids), "demo-default");
  });
  it("falls back to the shorter when only it matches", () => {
    assert.equal(attributeOne(res("demo-app"), ids), "demo");
  });
  it("returns undefined when nothing matches", () => {
    assert.equal(attributeOne(res("other-thing"), ids), undefined);
  });
});

describe("attributeResources", () => {
  it("buckets matched and unowned resources", () => {
    const { byInstance } = attributeResources(
      [res("demo-default-1"), res("demo-default-vpc"), res("stray-bucket")],
      ["demo-default"],
    );
    assert.equal(byInstance.get("demo-default")?.length, 2);
    assert.equal(byInstance.get(UNOWNED)?.length, 1);
  });
});

describe("summarize", () => {
  const meta = new Map<string, InstanceMeta>([
    ["demo-default", { id: "demo-default", name: "demo", status: "ready", mode: "vm", canView: true }],
  ]);

  it("orders known instances first and unowned last, computes totals + unpriced", () => {
    const groups = attributeResources(
      [
        res("demo-default-1", { costPerHour: 0.1, costSoFar: 2 }),
        res("stray", {}), // unpriced, unowned
      ],
      ["demo-default"],
    );
    const { groups: out, totals } = summarize(groups, meta);
    assert.equal(out[0].instanceId, "demo-default");
    assert.equal(out[0].instanceName, "demo");
    assert.equal(out[out.length - 1].instanceId, null); // unowned last
    assert.equal(totals.costPerHour, 0.1);
    assert.equal(totals.costSoFar, 2);
    assert.equal(totals.unpriced, 1);
    assert.equal(totals.resourceCount, 2);
  });

  it("flags an owned-but-unknown id as orphaned and hides identity of non-viewable ones", () => {
    const groups = attributeResources([res("gone-default-1")], ["gone-default"]);
    const { groups: out } = summarize(groups, new Map());
    assert.equal(out[0].instanceId, "gone-default");
    assert.equal(out[0].orphaned, true);
    assert.equal(out[0].instanceName, undefined);
  });
});
