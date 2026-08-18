import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeProgress } from "./progress.js";

const MULTI_APPLY = `
=== APPLY START 2026-08-18T10:48:17.003Z ===
# module.stack.module.network.google_compute_network.vpc will be created
# module.stack.module.network.google_compute_subnetwork.public_subnet will be created
# module.stack.module.re_vm[0].google_compute_instance.node1 will be created
# module.stack.module.re_vm[0].google_dns_record_set.node1 will be created
# module.stack.module.re_vm[0].random_password.password will be created
# module.stack.module.re_vm[1].google_compute_instance.node1 will be created
# module.stack.module.re_vm[1].google_compute_instance.nodeX[0] will be created
# module.stack.module.re_vm[1].google_dns_record_set.node1 will be created
# module.stack.module.re_vm[1].random_password.password will be created
# module.stack.module.app_vm.google_compute_instance.app[0] will be created
Plan: 10 to add, 0 to change, 0 to destroy.
module.stack.module.re_vm[0].google_compute_instance.node1: Creating...
module.stack.module.re_vm[0].google_compute_instance.node1: Creation complete after 12s
`;

const SINGLE_APPLY = `
=== APPLY START 2026-08-18T10:48:17.003Z ===
# module.stack.module.network.google_compute_network.vpc will be created
# module.stack.module.re_vm[0].google_compute_instance.node1 will be created
# module.stack.module.re_vm[0].google_dns_record_set.node1 will be created
Plan: 3 to add, 0 to change, 0 to destroy.
`;

const MULTI_DESTROY = `
=== DESTROY START 2026-08-18T11:00:00.000Z ===
# module.stack.module.re_vm[0].google_compute_instance.node1 will be destroyed
# module.stack.module.re_vm[1].google_compute_instance.node1 will be destroyed
# module.stack.module.re_vm[1].google_compute_instance.nodeX[0] will be destroyed
Plan: 0 to add, 0 to change, 3 to destroy.
module.stack.module.re_vm[1].google_compute_instance.node1: Destroying...
module.stack.module.re_vm[1].google_compute_instance.node1: Destruction complete after 8s
`;

describe("computeProgress cluster sections", () => {
  it("keeps a single Redis cluster as one nodes/DNS group", () => {
    const progress = computeProgress(SINGLE_APPLY, "applying", "vm");
    const ids = progress.sections.map((s) => s.id);
    assert.ok(ids.includes("nodes"));
    assert.ok(ids.includes("dns"));
    assert.ok(!ids.some((id) => id.startsWith("cluster-")));
  });

  it("splits Terraform resource progress per Redis cluster", () => {
    const progress = computeProgress(MULTI_APPLY, "applying", "vm", undefined, undefined, {
      clusterNames: ["cache", "search"],
    });
    const byId = Object.fromEntries(progress.sections.map((s) => [s.id, s]));
    assert.equal(byId["cluster-0"]?.label, "Redis cluster cache");
    assert.equal(byId["cluster-1"]?.label, "Redis cluster search");
    assert.equal(byId["cluster-0"]?.total, 3);
    assert.equal(byId["cluster-0"]?.done, 1);
    assert.equal(byId["cluster-1"]?.total, 4);
    assert.equal(byId["cluster-1"]?.done, 0);
    assert.equal(byId.network?.total, 2);
    assert.equal(byId.app?.total, 1);
    assert.ok(!progress.sections.some((s) => s.id === "nodes"));
  });

  it("falls back to Cluster 1 / Cluster 2 labels when names are empty", () => {
    const progress = computeProgress(MULTI_APPLY, "applying", "vm");
    const labels = progress.sections.filter((s) => s.id.startsWith("cluster-")).map((s) => s.label);
    assert.deepEqual(labels, ["Redis cluster 1", "Redis cluster 2"]);
  });

  it("splits destroy progress per Redis cluster", () => {
    const progress = computeProgress(MULTI_DESTROY, "destroying", "vm", undefined, undefined, {
      clusterNames: ["cache", "search"],
    });
    const byId = Object.fromEntries(progress.sections.map((s) => [s.id, s]));
    assert.equal(byId["cluster-0"]?.total, 1);
    assert.equal(byId["cluster-1"]?.total, 2);
    assert.equal(byId["cluster-1"]?.done, 1);
    assert.equal(byId["cluster-1"]?.state, "active");
  });
});
