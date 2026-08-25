import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeProgress, progressExtrasFromConfig } from "./progress.js";
import type { ClusterHealth } from "./types.js";

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

const READY_HEALTH: ClusterHealth = {
  state: "ready",
  nodesActive: 1,
  nodesExpected: 1,
  uiReachable: true,
  checkedAt: "2026-08-24T12:00:00.000Z",
  detail: "cluster ready",
};

describe("progressExtrasFromConfig", () => {
  it("counts databases and licenses on the configured clusters", () => {
    const extras = progressExtrasFromConfig(
      {
        clusters: [
          { name: "node1", nodes: 1, databases: [{ name: "db" }], license: "KEY" },
          { name: "node2", nodes: 1, databases: [{ name: "cache2" }] },
        ],
      },
      "vm",
    );
    assert.equal(extras.databaseCount, 2);
    assert.equal(extras.licenseCount, 1);
  });

  it("plans clone, docker, and start steps for a GitHub app run with Docker", () => {
    const extras = progressExtrasFromConfig(
      {
        applications: [
          {
            name: "demo-app",
            command: "docker compose up --build -d",
            artifact: { kind: "git", ref: "https://github.com/x/y", runInDocker: true },
            requirements: ["git", "docker"],
          },
        ],
      },
      "vm",
    );
    assert.deepEqual(extras.appWorkloads, [{ name: "demo-app", steps: ["clone", "docker", "start"] }]);
  });

  it("omits docker and start when those were not requested", () => {
    const extras = progressExtrasFromConfig(
      {
        applications: [{ name: "staged", artifact: { kind: "git", ref: "https://github.com/x/y" } }],
      },
      "vm",
    );
    assert.deepEqual(extras.appWorkloads, [{ name: "staged", steps: ["clone"] }]);
  });
});

describe("computeProgress databases and app workloads", () => {
  const applyDone = `
=== APPLY START 2026-08-24T12:00:00.000Z ===
Plan: 4 to add, 0 to change, 0 to destroy.
module.stack.module.network.google_compute_network.vpc: Creation complete after 2s
Apply complete! Resources: 4 added, 0 changed, 0 destroyed.
=== APPLY COMPLETE 2026-08-24T12:10:00.000Z ===
=== CLUSTER READY 2026-08-24T12:20:00.000Z — cluster ready ===
`;

  it("includes a databases step and stays below 100% until they finish", () => {
    const log = `${applyDone}
=== CREATING DATABASES 2026-08-24T12:20:05.000Z ===
  database node1/db FAILED: HTTP 406
`;
    const extras = progressExtrasFromConfig(
      { clusters: [{ name: "node1", databases: [{ name: "db" }] }] },
      "vm",
    );
    const progress = computeProgress(log, "bootstrapping", "vm", undefined, READY_HEALTH, extras);
    const dbStep = progress.steps.find((s) => s.id === "databases");
    assert.ok(dbStep, "databases step missing");
    assert.equal(dbStep?.state, "active");
    assert.ok(progress.percent < 100);
    const dbSection = progress.sections.find((s) => s.id === "databases");
    assert.equal(dbSection?.total, 1);
    assert.equal(dbSection?.done, 1);
  });

  it("reaches 100% after CLUSTER RESOURCES COMPLETE", () => {
    const log = `${applyDone}
=== CREATING DATABASES 2026-08-24T12:20:05.000Z ===
  database node1/db ready at redis-12000.cluster.x:12000
=== CLUSTER RESOURCES COMPLETE 2026-08-24T12:21:00.000Z ===
`;
    const extras = progressExtrasFromConfig(
      { clusters: [{ name: "node1", databases: [{ name: "db" }] }] },
      "vm",
    );
    const progress = computeProgress(log, "ready", "vm", undefined, READY_HEALTH, extras);
    assert.equal(progress.percent, 100);
    assert.equal(progress.steps.find((s) => s.id === "databases")?.state, "done");
  });

  it("tracks GitHub/Docker/start markers on the application workload", () => {
    const log = `
=== APPLY START 2026-08-24T12:00:00.000Z ===
Plan: 2 to add, 0 to change, 0 to destroy.
module.stack.module.app_workload["demo-app"].null_resource.deploy[0]: Creating...
=== APPWL demo-app STEP clone ===
=== APPWL demo-app STEP docker ===
`;
    const extras = progressExtrasFromConfig(
      {
        applications: [
          {
            name: "demo-app",
            command: "docker compose up -d",
            artifact: { kind: "git", ref: "https://github.com/x/y", runInDocker: true },
            requirements: ["docker"],
          },
        ],
      },
      "vm",
    );
    const progress = computeProgress(log, "applying", "vm", undefined, undefined, extras);
    const app = progress.sections.find((s) => s.id === "appwl-demo-app");
    assert.ok(app);
    assert.equal(app?.label, "Application demo-app");
    assert.equal(app?.total, 3);
    assert.equal(app?.done, 2);
    assert.equal(app?.state, "active");
  });

  it("skips Redis install steps for an app-only deploy", () => {
    const extras = progressExtrasFromConfig(
      {
        clusters: [],
        applications: [
          {
            name: "web",
            command: "true",
            artifact: { kind: "git", ref: "https://github.com/x/y" },
          },
        ],
      },
      "vm",
    );
    assert.deepEqual(extras.clusterNames, []);
    const progress = computeProgress(
      `
=== APPLY START 2026-08-25T12:00:00.000Z ===
Plan: 2 to add, 0 to change, 0 to destroy.
`,
      "applying",
      "vm",
      undefined,
      undefined,
      extras,
    );
    assert.ok(!progress.steps.some((s) => s.id === "bootstrap"));
    assert.match(progress.steps.find((s) => s.id === "ready")?.label || "", /application/i);
  });
});

