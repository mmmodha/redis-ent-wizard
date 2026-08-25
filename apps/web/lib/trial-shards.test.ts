import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRIAL_SHARD_LIMIT,
  clusterTrialShardGate,
  isTrialShardLicenseError,
  omitCreateInputDatabases,
  shardsForDatabase,
} from "./trial-shards.js";

describe("shardsForDatabase", () => {
  it("counts an unsharded database as one shard", () => {
    assert.equal(shardsForDatabase({ name: "cache", sharding: false }), 1);
  });

  it("doubles sharded masters when HA is on", () => {
    assert.equal(shardsForDatabase({ name: "db", sharding: true, shards_count: 2, replication: true }), 4);
  });

  it("does not count replica shards on a one-node cluster", () => {
    assert.equal(
      shardsForDatabase({ name: "db", sharding: true, shards_count: 2, replication: true }, 1),
      2,
    );
  });
});

describe("clusterTrialShardGate", () => {
  it("blocks unlicensed clusters over the trial shard cap", () => {
    const gate = clusterTrialShardGate({
      name: "test",
      databases: [
        { name: "testdb", sharding: true, shards_count: 2, replication: true },
        { name: "noreplication", sharding: false, replication: false },
      ],
      nodes: 3,
    });
    assert.equal(gate.blocked, true);
    assert.equal(gate.shards, 5);
    assert.equal(gate.limit, TRIAL_SHARD_LIMIT);
    assert.match(gate.message, /trial license allows 4/i);
    assert.match(gate.message, /without databases/i);
  });

  it("allows the same layout when a license is present", () => {
    const gate = clusterTrialShardGate({
      name: "test",
      license: "KEY",
      databases: [{ name: "testdb", sharding: true, shards_count: 2, replication: true }],
      nodes: 3,
    });
    assert.equal(gate.blocked, false);
  });

  it("allows an unlicensed cluster at or under the trial cap", () => {
    const gate = clusterTrialShardGate({
      databases: [
        { name: "a", sharding: false, replication: true },
        { name: "b", sharding: false, replication: false },
      ],
      nodes: 3,
    });
    assert.equal(gate.blocked, false);
    assert.equal(gate.shards, 3);
  });
});

describe("omitCreateInputDatabases", () => {
  it("strips databases so the cluster can be applied without them", () => {
    const out = omitCreateInputDatabases({
      name: "x",
      clusters: [{ name: "test", databases: [{ name: "testdb" }], nodes: 3 }],
    });
    assert.equal(out.name, "x");
    const clusters = out.clusters as Array<Record<string, unknown>>;
    assert.equal(clusters[0].name, "test");
    assert.equal(clusters[0].databases, undefined);
    assert.equal(clusters[0].nodes, 3);
  });
});

describe("isTrialShardLicenseError", () => {
  it("matches the RE trial shard 400", () => {
    assert.equal(
      isTrialShardLicenseError(
        'HTTP 400: {"error_code":"invalid_license","description":"Total shards count exceeds amount of total shards permitted by license"}',
      ),
      true,
    );
    assert.equal(isTrialShardLicenseError("HTTP 406: missing shard_key_regex"), false);
  });
});
