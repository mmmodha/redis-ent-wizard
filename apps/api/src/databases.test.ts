import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBdbPayload, capacityFor, clusterCapacityBytes, hasDatabases, hasLicenses, requiredDbBytes } from "./databases.js";
import type { InstanceRecord } from "./types.js";

const GIB = 1024 * 1024 * 1024;

describe("clusterCapacityBytes", () => {
  it("applies the 0.85 usable fraction across nodes", () => {
    // 3 nodes x 8192 MB = 24 GiB raw, x0.85 usable
    const cap = clusterCapacityBytes(3, 8192);
    assert.equal(cap, Math.floor(3 * 8192 * 1024 * 1024 * 0.85));
  });

  it("is zero for zero nodes or memory", () => {
    assert.equal(clusterCapacityBytes(0, 8192), 0);
    assert.equal(clusterCapacityBytes(3, 0), 0);
  });
});

describe("requiredDbBytes", () => {
  it("counts replication as double footprint", () => {
    assert.equal(requiredDbBytes([{ name: "a", memory_gb: 2, replication: true }]), 2 * GIB * 2);
  });

  it("counts a non-replicated db once and sums multiple", () => {
    const bytes = requiredDbBytes([
      { name: "a", memory_gb: 1 },
      { name: "b", memory_gb: 3, replication: false },
    ]);
    assert.equal(bytes, 4 * GIB);
  });

  it("treats an empty list as zero", () => {
    assert.equal(requiredDbBytes([]), 0);
    assert.equal(requiredDbBytes(), 0);
  });
});

function record(clusters: unknown[]): InstanceRecord {
  return {
    id: "x-default", name: "x", mode: "vm", status: "ready",
    createdAt: "", updatedAt: "", project: "p", region: "europe-west1",
    ownerEmail: "a_b", credentialsFile: "/dev/null",
    config: { name: "x", mode: "vm", clusters },
  } as unknown as InstanceRecord;
}

describe("hasLicenses / hasDatabases", () => {
  it("detects a per-cluster license", () => {
    assert.equal(hasLicenses(record([{ nodes: 3, license: "KEY" }])), true);
    assert.equal(hasLicenses(record([{ nodes: 3 }])), false);
    assert.equal(hasLicenses(record([{ nodes: 3, license: "   " }])), false);
  });
  it("detects configured databases", () => {
    assert.equal(hasDatabases(record([{ nodes: 3, databases: [{ name: "a", memory_gb: 1 }] }])), true);
    assert.equal(hasDatabases(record([{ nodes: 3 }])), false);
  });
});

describe("buildBdbPayload", () => {
  it("defaults to single proxy with no oss_cluster (avoids the 406)", () => {
    const p = buildBdbPayload({ name: "d", memory_gb: 1, sharding: true, shards_count: 9 });
    assert.equal(p.proxy_policy, "single");
    assert.equal(p.oss_cluster, false);
    assert.equal(p.shard_key_regex, undefined);
    assert.equal(p.shards_placement, "dense");
  });

  it("oss_cluster forces the all-master-shards proxy and adds a hash regex", () => {
    const p = buildBdbPayload({
      name: "d",
      memory_gb: 1,
      sharding: true,
      shards_count: 9,
      oss_cluster: true,
      proxy_policy: "single", // overridden by oss_cluster
      shards_placement: "sparse",
    });
    assert.equal(p.oss_cluster, true);
    assert.equal(p.proxy_policy, "all-master-shards");
    assert.equal(p.shards_placement, "sparse");
    assert.ok(Array.isArray(p.shard_key_regex));
  });

  it("sharded all-master-shards without oss still gets a shard_key_regex", () => {
    const p = buildBdbPayload({ name: "d", memory_gb: 1, sharding: true, proxy_policy: "all-master-shards" });
    assert.equal(p.proxy_policy, "all-master-shards");
    assert.equal(p.oss_cluster, false);
    assert.ok(Array.isArray(p.shard_key_regex)); // required for per-shard routing
  });

  it("sharded single-proxy uses standard hashing (no shard_key_regex)", () => {
    const p = buildBdbPayload({ name: "d", memory_gb: 1, sharding: true, shards_count: 4, proxy_policy: "single" });
    assert.equal(p.proxy_policy, "single");
    assert.equal(p.shard_key_regex, undefined);
  });

  it("flex enables bigstore with a RAM portion", () => {
    const p = buildBdbPayload({ name: "d", memory_gb: 100, flex: true });
    assert.equal(p.bigstore, true);
    assert.equal(p.bigstore_ram_size, Math.round(100 * GIB * 0.1));
    const noflex = buildBdbPayload({ name: "d", memory_gb: 100 });
    assert.equal(noflex.bigstore, undefined);
  });
});

describe("requiredDbBytes with flex", () => {
  it("counts a flex db at its RAM portion, not full size", () => {
    assert.equal(requiredDbBytes([{ name: "f", memory_gb: 100, flex: true }]), Math.round(100 * GIB * 0.1));
    // replication doubles the RAM portion
    assert.equal(requiredDbBytes([{ name: "f", memory_gb: 100, flex: true, replication: true }]), Math.round(100 * GIB * 0.1) * 2);
  });
});

describe("capacityFor", () => {
  it("fits when required is under capacity", () => {
    const r = capacityFor(3, 8192, [{ name: "a", memory_gb: 2, replication: true }]);
    assert.equal(r.ok, true);
    assert.ok(r.remaining > 0);
    assert.equal(r.required, 2 * GIB * 2);
  });

  it("fails when replicated databases exceed usable memory", () => {
    // 1 node x 2048 MB ~ 1.7 GiB usable; a replicated 2 GB db needs 4 GiB
    const r = capacityFor(1, 2048, [{ name: "big", memory_gb: 2, replication: true }]);
    assert.equal(r.ok, false);
    assert.ok(r.remaining < 0);
  });
});
