import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRIAL_SHARD_LIMIT, clusterTrialShardGate, shardsForDatabase } from "./trial-shards.js";

describe("shardsForDatabase", () => {
  it("counts an unsharded database as one shard", () => {
    assert.equal(shardsForDatabase({ sharding: false }), 1);
  });

  it("doubles sharded masters when HA is on", () => {
    assert.equal(shardsForDatabase({ sharding: true, shards_count: 2, replication: true }), 4);
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

  it("does not block when a license is configured", () => {
    const gate = clusterTrialShardGate({
      license: "KEY",
      databases: [{ name: "testdb", sharding: true, shards_count: 2, replication: true }],
      nodes: 3,
    });
    assert.equal(gate.blocked, false);
  });
});
