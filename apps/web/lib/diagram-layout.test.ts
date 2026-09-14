import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LAYOUT,
  NODE_SIZE,
  ROOT_ID,
  layoutDiagram,
  rootNode,
  type DesignEdge,
  type DesignNode,
} from "./diagram.js";

function appNode(id: string): DesignNode {
  return {
    id,
    type: "application",
    position: { x: 0, y: 0 },
    parentId: ROOT_ID,
    data: {
      kind: "application",
      name: id,
      command: "",
      ports: "",
      env: [],
      requirements: [],
      artifact: { kind: "upload", ref: "", type: "jar" },
      vm_count: 1,
      machine_type: "",
      disk_gib: 0,
      image: "",
      replicas: 1,
      expose: "none",
    },
  };
}

function clusterNode(id: string): DesignNode {
  return {
    id,
    type: "cluster",
    position: { x: 0, y: 0 },
    parentId: ROOT_ID,
    data: {
      kind: "cluster",
      name: id,
      nodes: 3,
      machine_type: "e2-standard-2",
      rof_nvme_disks: 0,
      rs_version: "8.2.0",
      rec_nodes: 3,
    },
  };
}

function databaseNode(id: string, parentId: string): DesignNode {
  return {
    id,
    type: "database",
    position: { x: 0, y: 0 },
    parentId,
    data: {
      kind: "database",
      name: id,
      memory_gb: 8,
      replication: false,
      sharding: true,
      shards_count: 2,
      eviction_policy: "noeviction",
      port: 12000,
      password: "",
      modules: [],
      proxy_policy: "single",
      shards_placement: "dense",
      oss_cluster: false,
      flex: false,
    },
  };
}

function box(n: DesignNode) {
  const width = typeof n.style?.width === "number" ? n.style.width : 0;
  const height = typeof n.style?.height === "number" ? n.style.height : 0;
  return {
    x: n.position.x,
    y: n.position.y,
    width,
    height,
    right: n.position.x + width,
    bottom: n.position.y + height,
  };
}

describe("diagram layout sizes", () => {
  it("uses the 8px grid for padding and sibling gaps", () => {
    assert.equal(LAYOUT.PAD % 8, 0);
    assert.equal(LAYOUT.GAP % 8, 0);
    assert.ok(LAYOUT.PAD >= 32);
    assert.ok(LAYOUT.GAP >= 24);
  });

  it("reserves cluster header space for title, machine type, and capacity", () => {
    assert.equal(LAYOUT.CLUSTER_HEADER % 8, 0);
    assert.ok(LAYOUT.CLUSTER_HEADER >= 120);
  });

  it("sizes a database node to hold title, memory, badges, and endpoint", () => {
    assert.equal(NODE_SIZE.database.width % 8, 0);
    assert.equal(NODE_SIZE.database.height % 8, 0);
    assert.ok(NODE_SIZE.database.width >= 248);
    assert.ok(NODE_SIZE.database.height >= 192);
  });
});

describe("layoutDiagram nested databases", () => {
  it("stacks databases inside a cluster with padding and no overlap", () => {
    const laid = layoutDiagram([
      rootNode("vm"),
      clusterNode("cluster-a"),
      databaseNode("db-1", "cluster-a"),
      databaseNode("db-2", "cluster-a"),
    ]);
    const cluster = laid.find((n) => n.id === "cluster-a")!;
    const db1 = laid.find((n) => n.id === "db-1")!;
    const db2 = laid.find((n) => n.id === "db-2")!;
    const c = box(cluster);
    const a = box(db1);
    const b = box(db2);

    assert.equal(a.x, LAYOUT.PAD);
    assert.equal(a.y, LAYOUT.CLUSTER_HEADER);
    assert.equal(b.x, LAYOUT.PAD);
    assert.equal(b.y, a.bottom + LAYOUT.GAP);
    assert.ok(b.y >= a.bottom + LAYOUT.GAP);
    assert.ok(a.right + LAYOUT.PAD <= c.width);
    assert.ok(b.bottom + LAYOUT.PAD <= c.height);
  });

  it("grows the cluster so inner database boxes stay fully enclosed", () => {
    const laid = layoutDiagram([
      rootNode("vm"),
      clusterNode("cluster-a"),
      databaseNode("db-1", "cluster-a"),
      databaseNode("db-2", "cluster-a"),
    ]);
    const cluster = laid.find((n) => n.id === "cluster-a")!;
    const dbs = laid.filter((n) => n.data.kind === "database").map(box);
    const c = box(cluster);
    const expectedHeight =
      LAYOUT.CLUSTER_HEADER +
      dbs.length * NODE_SIZE.database.height +
      (dbs.length - 1) * LAYOUT.GAP +
      LAYOUT.PAD;

    assert.equal(
      c.width,
      Math.max(NODE_SIZE.cluster.width, NODE_SIZE.database.width + 2 * LAYOUT.PAD),
    );
    assert.equal(c.height, expectedHeight);
    for (const db of dbs) {
      assert.ok(db.x >= LAYOUT.PAD);
      assert.ok(db.y >= LAYOUT.CLUSTER_HEADER);
      assert.ok(db.right <= c.width - LAYOUT.PAD);
      assert.ok(db.bottom <= c.height - LAYOUT.PAD);
    }
  });
});

describe("layoutDiagram dagre placement", () => {
  const nodes = () => [rootNode("vm"), appNode("app-1"), clusterNode("cluster-a")];
  const edges: DesignEdge[] = [{ id: "e", source: "app-1", target: "cluster-a" }];

  it("separates a wired consumer and provider along the rank axis (LR)", () => {
    const laid = layoutDiagram(nodes(), edges);
    const app = laid.find((n) => n.id === "app-1")!;
    const cluster = laid.find((n) => n.id === "cluster-a")!;
    // Left→right: the consumer (edge source) ranks left of the provider (target).
    assert.ok(app.position.x < cluster.position.x, "consumer should sit left of provider");
    // Top-level components are placed below the root's title chrome.
    assert.ok(app.position.y >= LAYOUT.ROOT_HEADER - LAYOUT.PAD);
  });

  it("is deterministic / idempotent for the same (nodes, edges)", () => {
    const once = layoutDiagram(nodes(), edges);
    const twice = layoutDiagram(once, edges);
    for (const n of once) {
      const m = twice.find((x) => x.id === n.id)!;
      assert.equal(n.position.x, m.position.x);
      assert.equal(n.position.y, m.position.y);
    }
  });
});
