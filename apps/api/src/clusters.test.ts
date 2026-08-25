import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clusterNamePrefix,
  countRedisClusters,
  normalizeClusterName,
  normalizeClusters,
  plannedDnsNames,
  summarizeClusters,
  totalClusterNodes,
} from "./clusters.js";

describe("normalizeClusters", () => {
  it("builds one cluster from legacy VM fields", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clustersize: 5,
      machine_type: "n2-standard-8",
      rof_nvme_disks: 2,
      RS_release:
        "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar",
    });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].nodes, 5);
    assert.equal(clusters[0].machine_type, "n2-standard-8");
    assert.equal(clusters[0].rof_nvme_disks, 2);
    assert.equal(clusters[0].rs_version, "8.2.0-46");
    assert.match(clusters[0].RS_release, /8\.2\.0-46-jammy-amd64\.tar$/);
  });

  it("builds one GKE cluster from rec_nodes", () => {
    const clusters = normalizeClusters({ mode: "gke", rec_nodes: 5 });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].nodes, 5);
    assert.equal(clusters[0].rec_nodes, 5);
  });

  it("keeps up to three explicit clusters and fills defaults", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clusters: [
        { nodes: 3, machine_type: "e2-standard-2", rs_version: "8.2.0-46" },
        { nodes: 1, machine_type: "e2-standard-4" },
      ],
    });
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].nodes, 3);
    assert.equal(clusters[1].nodes, 1);
    assert.equal(clusters[1].rs_version, "8.2.0-46");
    assert.equal(clusters[0].name, "");
    assert.equal(clusters[1].name, "");
  });

  it("carries databases and license through normalization", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clusters: [
        {
          name: "cache",
          nodes: 3,
          machine_type: "n2-standard-8",
          databases: [{ name: "sessions", memory_gb: 2, replication: true }],
          license: "LICENSE-KEY",
        },
      ],
    });
    assert.equal(clusters[0].databases?.length, 1);
    assert.equal(clusters[0].databases?.[0].name, "sessions");
    assert.equal(clusters[0].license, "LICENSE-KEY");
  });

  it("omits an empty databases list and a blank license", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clusters: [{ name: "cache", nodes: 3, machine_type: "n2-standard-8", databases: [], license: "   " }],
    });
    assert.equal(clusters[0].databases, undefined);
    assert.equal(clusters[0].license, undefined);
  });

  it("slugifies unique cluster names", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clusters: [
        { name: "Cache Prod", nodes: 3 },
        { name: "search-fq", nodes: 1 },
      ],
    });
    assert.equal(clusters[0].name, "cache-prod");
    assert.equal(clusters[1].name, "search-fq");
  });

  it("rejects duplicate cluster names", () => {
    assert.throws(
      () =>
        normalizeClusters({
          mode: "vm",
          clusters: [{ name: "cache" }, { name: "Cache" }],
        }),
      /unique|duplicate/i,
    );
  });

  it("rejects reserved cluster names", () => {
    assert.throws(
      () => normalizeClusters({ mode: "vm", clusters: [{ name: "app" }] }),
      /reserved/i,
    );
  });

  it("rejects more than three clusters", () => {
    assert.throws(
      () =>
        normalizeClusters({
          mode: "vm",
          clusters: [{ nodes: 1 }, { nodes: 1 }, { nodes: 1 }, { nodes: 1 }],
        }),
      /1–3|1-3|at most 3/,
    );
  });

  it("keeps an explicit empty cluster list so an app-only deploy skips Redis", () => {
    const clusters = normalizeClusters({ mode: "vm", clusters: [], clustersize: 3 });
    assert.deepEqual(clusters, []);
    assert.equal(countRedisClusters({ mode: "vm", clusters: [] }), 0);
  });

  it("skips Redis when redis_enabled is false even if legacy size fields are set", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      redis_enabled: false,
      clustersize: 5,
      machine_type: "n2-standard-8",
    });
    assert.deepEqual(clusters, []);
  });
});

describe("normalizeClusterName", () => {
  it("lowercases, hyphenates, and trims to a GCP-safe slug", () => {
    assert.equal(normalizeClusterName("Cache Prod"), "cache-prod");
    assert.equal(normalizeClusterName("  SEARCH_FQ  "), "search-fq");
    assert.equal(normalizeClusterName(""), "");
  });
});

describe("clusterNamePrefix", () => {
  it("keeps unnamed clusters on the legacy c2/c3 suffix", () => {
    assert.equal(clusterNamePrefix("demo01-default", 0), "demo01-default");
    assert.equal(clusterNamePrefix("demo01-default", 1), "demo01-default-c2");
    assert.equal(clusterNamePrefix("demo01-default", 2), "demo01-default-c3");
  });

  it("appends a cluster name to instance-env for every cluster", () => {
    assert.equal(clusterNamePrefix("demo01-default", 0, "cache"), "demo01-default-cache");
    assert.equal(clusterNamePrefix("demo01-default", 1, "search"), "demo01-default-search");
  });
});

describe("plannedDnsNames", () => {
  it("lists cluster NS, per-node A records, and app hosts in the shared zone", () => {
    const names = plannedDnsNames({
      deploymentPrefix: "alice-default",
      dnsZone: "demo.redislabs.com",
      clusters: [
        { name: "cache", nodes: 1 },
        { name: "search", nodes: 3 },
      ],
      appCount: 2,
    });
    assert.ok(names.includes("cluster.alice-default-cache.demo.redislabs.com"));
    assert.ok(names.includes("node1.alice-default-cache.demo.redislabs.com"));
    assert.ok(names.includes("cluster.alice-default-search.demo.redislabs.com"));
    assert.ok(names.includes("node3.alice-default-search.demo.redislabs.com"));
    assert.ok(names.includes("app.alice-default.demo.redislabs.com"));
    assert.ok(names.includes("app.alice-default-1.demo.redislabs.com"));
    assert.ok(!names.includes("node2.alice-default-cache.demo.redislabs.com"));
  });
});

describe("cluster summaries", () => {
  it("sums nodes and counts Redis clusters", () => {
    const clusters = normalizeClusters({
      mode: "vm",
      clusters: [{ nodes: 3 }, { nodes: 5 }],
    });
    assert.equal(totalClusterNodes(clusters), 8);
    assert.equal(countRedisClusters({ mode: "vm", clusters }), 2);
    assert.equal(countRedisClusters({ mode: "vm", clustersize: 3 }), 1);
    assert.match(summarizeClusters(clusters), /3 × e2-standard-2/);
  });
});
