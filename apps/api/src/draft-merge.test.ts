import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeDraftConfig } from "./draft-merge.js";

describe("mergeDraftConfig — deep patch", () => {
  it("merges top-level scalars, keeping omitted keys", () => {
    const out = mergeDraftConfig(
      { name: "demo", env: "default", mode: "vm", project: "p1", region_name: "europe-west1" },
      { project: "p2" },
    );
    assert.equal(out.project, "p2");
    assert.equal(out.region_name, "europe-west1"); // untouched
  });

  it("merges clusters by name and keeps clusters the patch doesn't mention", () => {
    const out = mergeDraftConfig(
      {
        name: "demo",
        clusters: [
          { name: "cache", nodes: 3 },
          { name: "search", nodes: 3 },
        ],
      },
      { clusters: [{ name: "cache", nodes: 5 }] },
    );
    const clusters = out.clusters as Array<Record<string, unknown>>;
    assert.equal(clusters.length, 2);
    assert.equal(clusters.find((c) => c.name === "cache")?.nodes, 5); // patched
    assert.equal(clusters.find((c) => c.name === "search")?.nodes, 3); // kept
  });

  it("appends a cluster with a new name", () => {
    const out = mergeDraftConfig(
      { name: "demo", clusters: [{ name: "cache", nodes: 3 }] },
      { clusters: [{ name: "analytics", nodes: 3 }] },
    );
    assert.deepEqual((out.clusters as Array<{ name: string }>).map((c) => c.name), ["cache", "analytics"]);
  });

  it("merges databases within a cluster by name", () => {
    const out = mergeDraftConfig(
      { name: "demo", clusters: [{ name: "cache", databases: [{ name: "sessions", memory_gb: 1 }] }] },
      { clusters: [{ name: "cache", databases: [{ name: "sessions", memory_gb: 4 }] }] },
    );
    const db = ((out.clusters as any[])[0].databases as any[])[0];
    assert.equal(db.memory_gb, 4);
  });

  it("merges operators by name and keeps operators the patch omits", () => {
    const out = mergeDraftConfig(
      {
        name: "demo",
        mode: "gke",
        operators: [
          { name: "operator", operator_chart_version: "latest" },
          { name: "search-ops", operator_chart_version: "7.8.6-2" },
        ],
      },
      { operators: [{ name: "operator", operator_chart_version: "7.22.2-16" }] },
    );
    const ops = out.operators as Array<Record<string, unknown>>;
    assert.equal(ops.length, 2);
    assert.equal(ops.find((o) => o.name === "operator")?.operator_chart_version, "7.22.2-16"); // patched
    assert.equal(ops.find((o) => o.name === "search-ops")?.operator_chart_version, "7.8.6-2"); // kept
  });

  it("replaces plain value arrays (not name-keyed)", () => {
    const out = mergeDraftConfig(
      { name: "demo", region_zones: ["b", "c", "d"] },
      { region_zones: ["a"] },
    );
    assert.deepEqual(out.region_zones, ["a"]);
  });
});

describe("mergeDraftConfig — protected human fields", () => {
  it("keeps a human-set cluster license even when the patch changes the cluster", () => {
    const out = mergeDraftConfig(
      { name: "demo", clusters: [{ name: "cache", nodes: 3, license: "HUMAN-LICENSE-KEY" }] },
      { clusters: [{ name: "cache", nodes: 5 }] },
    );
    const cache = (out.clusters as any[])[0];
    assert.equal(cache.nodes, 5);
    assert.equal(cache.license, "HUMAN-LICENSE-KEY"); // preserved
  });

  it("refuses to overwrite a set license even if the patch supplies one", () => {
    const out = mergeDraftConfig(
      { name: "demo", clusters: [{ name: "cache", license: "HUMAN" }] },
      { clusters: [{ name: "cache", license: "AI-TRIED-TO-CHANGE" }] },
    );
    assert.equal((out.clusters as any[])[0].license, "HUMAN");
  });

  it("preserves per-cluster admin and database passwords", () => {
    const out = mergeDraftConfig(
      {
        name: "demo",
        clusters: [
          {
            name: "cache",
            RS_admin: "ops@redis.io",
            databases: [{ name: "sessions", password: "s3cret" }],
          },
        ],
      },
      { clusters: [{ name: "cache", RS_admin: "ai@x", databases: [{ name: "sessions", memory_gb: 2, password: "" }] }] },
    );
    const cache = (out.clusters as any[])[0];
    assert.equal(cache.RS_admin, "ops@redis.io");
    const db = (cache.databases as any[])[0];
    assert.equal(db.memory_gb, 2); // non-protected field patched
    assert.equal(db.password, "s3cret"); // protected
  });

  it("allows setting a protected field when the existing value is empty", () => {
    const out = mergeDraftConfig(
      { name: "demo", clusters: [{ name: "cache", license: "" }] },
      { clusters: [{ name: "cache", license: "FIRST-LICENSE" }] },
    );
    assert.equal((out.clusters as any[])[0].license, "FIRST-LICENSE");
  });

  it("keeps name/env from the existing draft (no silent rename)", () => {
    const out = mergeDraftConfig({ name: "demo", env: "prod" }, { name: "hacked", env: "default" });
    assert.equal(out.name, "demo");
    assert.equal(out.env, "prod");
  });
});
