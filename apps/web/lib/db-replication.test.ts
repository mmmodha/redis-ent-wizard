import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canEnableDbReplication,
  clusterRedisNodeCount,
  dbReplicationHint,
  effectiveDbReplication,
} from "./db-replication.js";

describe("canEnableDbReplication", () => {
  it("is false for a single-node cluster", () => {
    assert.equal(canEnableDbReplication(1), false);
    assert.equal(canEnableDbReplication(0), false);
  });

  it("is true once the cluster has two or more nodes", () => {
    assert.equal(canEnableDbReplication(2), true);
    assert.equal(canEnableDbReplication(3), true);
  });
});

describe("effectiveDbReplication", () => {
  it("never enables replication on a one-node cluster", () => {
    assert.equal(effectiveDbReplication(true, 1), false);
    assert.equal(effectiveDbReplication(false, 1), false);
  });

  it("honors the requested flag when the cluster has enough nodes", () => {
    assert.equal(effectiveDbReplication(true, 3), true);
    assert.equal(effectiveDbReplication(false, 3), false);
  });
});

describe("clusterRedisNodeCount", () => {
  it("uses VM node count in vm mode and REC count in gke mode", () => {
    const cluster = { nodes: 1, rec_nodes: 3 };
    assert.equal(clusterRedisNodeCount(cluster, "vm"), 1);
    assert.equal(clusterRedisNodeCount(cluster, "gke"), 3);
  });
});

describe("dbReplicationHint", () => {
  it("explains why HA is locked on a one-node cluster", () => {
    assert.match(dbReplicationHint(1), /2 nodes/i);
    assert.equal(dbReplicationHint(3), "");
  });
});
