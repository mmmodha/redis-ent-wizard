import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overlayInstanceLive } from "./instance-live.js";
import type { DesignNode } from "./diagram.js";

function node(partial: Partial<DesignNode> & { id: string; data: DesignNode["data"] }): DesignNode {
  return {
    type: partial.type || partial.data.kind,
    position: { x: 0, y: 0 },
    ...partial,
  } as DesignNode;
}

describe("overlayInstanceLive", () => {
  it("stamps database nodes with REST create status", () => {
    const cluster = node({
      id: "cluster-1",
      data: { kind: "cluster", name: "node1", nodes: 1, machine_type: "e2-standard-2", rof_nvme_disks: 0, rs_version: "8.2", rec_nodes: 1 },
    });
    const db = node({
      id: "database-1",
      parentId: "cluster-1",
      data: { kind: "database", name: "db", memory_gb: 2, replication: false, sharding: false, shards_count: 1, eviction_policy: "noeviction", port: 12000, password: "", modules: [], proxy_policy: "single", shards_placement: "dense", oss_cluster: false, flex: false },
    });
    const out = overlayInstanceLive([cluster, db], {
      databaseStates: [
        { cluster: "node1", name: "db", status: "failed", error: "HTTP 406: invalid_replication" },
      ],
    });
    const live = out.find((n) => n.id === "database-1")?.data as { liveStatus?: string; liveDetail?: string };
    assert.equal(live.liveStatus, "failed");
    assert.match(String(live.liveDetail), /406/);
  });

  it("attaches app VM IP and DNS from terraform outputs", () => {
    const app = node({
      id: "application-1",
      data: {
        kind: "application",
        name: "demo-app",
        command: "docker compose up -d",
        ports: "8080",
        env: [],
        requirements: ["git", "docker"],
        artifact: { kind: "git", ref: "https://github.com/x/y", type: "binary", runInDocker: true },
        vm_count: 1,
        machine_type: "e2-highmem-2",
        disk_gib: 0,
        image: "",
        replicas: 1,
        expose: "none",
      },
    });
    const out = overlayInstanceLive([app], {
      endpoints: {
        app_workloads: [{ app_name: "demo-app", ip: "10.1.2.3", dns: "demo-app.x.demo.redislabs.com" }],
      },
    });
    const live = out[0].data as { liveStatus?: string; liveDetail?: string };
    assert.equal(live.liveStatus, "ready");
    assert.match(String(live.liveDetail), /10\.1\.2\.3/);
  });
});
