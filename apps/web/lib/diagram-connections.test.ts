import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInputToDiagram,
  diagramToCreateInput,
  exposedVariables,
  reconcileRdiInternalNodes,
  ROOT_ID,
  type DesignEdge,
  type DesignNode,
  type DesignSettings,
} from "./diagram.js";

const settings: DesignSettings = {
  name: "demo",
  env: "default",
  folder: "",
  youremail: "jane_doe",
  skip_deletion: true,
  mode: "vm",
  RS_admin: "admin@redis.io",
  operator_chart_version: "latest",
  credentialsFile: "key.json",
  project: "proj",
  region_name: "europe-west1",
  region_zones: ["b", "c", "d"],
  dns_managed_zone: "demo-clusters",
  dns_zone_dns_name: "demo.redislabs.com",
};

function node(id: string, kind: string, data: Record<string, unknown>, parentId?: string): DesignNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
    data: { kind, ...data } as DesignNode["data"],
  };
}

function buildDiagram(): { nodes: DesignNode[]; edges: DesignEdge[] } {
  const nodes: DesignNode[] = [
    node(ROOT_ID, "network", { label: "VPC" }),
    node("c1", "cluster", { name: "cache", nodes: 3, machine_type: "n2-standard-8", rof_nvme_disks: 0, rs_version: "8.2.0-46", rec_nodes: 3 }, ROOT_ID),
    node("db1", "database", { name: "sessions", memory_gb: 1, replication: true, sharding: false, shards_count: 1, eviction_policy: "noeviction", port: 12000, password: "", modules: [], proxy_policy: "single", shards_placement: "dense", oss_cluster: false, flex: false }, "c1"),
    node("app1", "application", { name: "web", command: "java -jar app.jar", ports: "8080", env: [], requirements: [], artifact: { kind: "url", ref: "https://x/app.jar", type: "jar" }, vm_count: 1, machine_type: "e2-standard-2", disk_gib: 0, image: "", replicas: 1, expose: "none" }, ROOT_ID),
    node("v1", "vms", { name: "", count: 2, machine_type: "e2-standard-2", disk_gib: 0, memviz_enabled: false, expose_http: false, expose_https: false, extra_ports: "" }, ROOT_ID),
    node("lb1", "loadbalancer", { name: "front", expose_http: true, expose_https: false, extra_ports: "" }, ROOT_ID),
    node("s1", "storage", { name: "assets", location: "", storage_class: "STANDARD", versioning: false, force_destroy: true, access: "readwrite" }, ROOT_ID),
    node("p1", "pubsub", { name: "events", create_subscription: true, role: "both" }, ROOT_ID),
    node("bq1", "bigquery", { name: "analytics", location: "", access: "readwrite" }, ROOT_ID),
    node("sql1", "cloudsql", { name: "orders", engine: "postgres", tier: "db-f1-micro", db_name: "appdb", db_user: "appuser", connectivity: "private" }, ROOT_ID),
    node("dbt", "database", { name: "target", memory_gb: 1, replication: false, sharding: false, shards_count: 1, eviction_policy: "noeviction", port: 12000, password: "", modules: [], proxy_policy: "single", shards_placement: "dense", oss_cluster: false, flex: false }, "c1"),
    node("rdi1", "rdi", { name: "ingest", machine_type: "n2-standard-4" }, ROOT_ID),
  ];
  const edges: DesignEdge[] = [
    { id: "e1", source: "lb1", target: "app1" }, // LB fronts the app
    { id: "e2", source: "app1", target: "c1" }, //  app consumes cluster
    { id: "e3", source: "app1", target: "db1" }, // app consumes database
    { id: "e4", source: "v1", target: "db1" }, //   Set-of-VMs consumes database
    { id: "e5", source: "v1", target: "lb1" }, //   Set-of-VMs consumes the app's LB VIP
    { id: "e6", source: "app1", target: "s1" }, //  app consumes the storage bucket
    { id: "e7", source: "app1", target: "p1" }, //  app consumes the Pub/Sub topic
    { id: "e8", source: "app1", target: "bq1" }, // app consumes the BigQuery dataset
    { id: "e9", source: "app1", target: "sql1" }, // app consumes the Cloud SQL instance
    { id: "e10", source: "v1", target: "sql1" }, //  Set-of-VMs consumes the Cloud SQL instance
    { id: "e11", source: "rdi1", target: "sql1" }, // RDI ingests from the Cloud SQL source
    { id: "e12", source: "rdi1", target: "dbt" }, //  RDI writes to the target database
  ];
  return { nodes, edges };
}

describe("diagramToCreateInput connections", () => {
  it("derives connect* on applications and load_balancers", () => {
    const { nodes, edges } = buildDiagram();
    const payload = diagramToCreateInput(nodes, edges, settings) as Record<string, any>;
    const app = payload.applications[0];
    assert.deepEqual(app.connectClusters, ["cache"]);
    assert.deepEqual(app.connectDatabases, ["sessions"]);
    assert.deepEqual(app.connectStorage, ["assets"]);
    assert.deepEqual(app.connectPubsub, ["events"]);
    // The LB fronts the app; the app itself does not consume it.
    assert.equal(app.connectLoadBalancers, undefined);
    const lb = payload.load_balancers.find((l: any) => l.target === "web");
    assert.ok(lb, "load balancer fronting the app exists");
    assert.equal(lb.name, "front");
    assert.equal(lb.target_kind, "application");
    const bucket = payload.storage_buckets.find((b: any) => b.name === "assets");
    assert.ok(bucket, "storage bucket present");
    assert.equal(bucket.access, "readwrite");
    const topic = payload.pubsub_topics.find((t: any) => t.name === "events");
    assert.ok(topic, "pubsub topic present");
    assert.equal(topic.create_subscription, true);
    assert.deepEqual(app.connectBigquery, ["analytics"]);
    const ds = payload.bigquery_datasets.find((d: any) => d.name === "analytics");
    assert.ok(ds, "bigquery dataset present");
    assert.equal(ds.access, "readwrite");
    assert.deepEqual(app.connectSql, ["orders"]);
    const sql = payload.cloud_sql_instances.find((s: any) => s.name === "orders");
    assert.ok(sql, "cloud sql instance present");
    assert.equal(sql.engine, "postgres");
    assert.equal(sql.connectivity, "private");
  });

  it("derives vms_connect for the Set-of-VMs group", () => {
    const { nodes, edges } = buildDiagram();
    const payload = diagramToCreateInput(nodes, edges, settings) as Record<string, any>;
    assert.deepEqual(payload.vms_connect.databases, ["sessions"]);
    assert.deepEqual(payload.vms_connect.load_balancers, ["front"]);
    assert.deepEqual(payload.vms_connect.sql, ["orders"]);
    assert.equal(payload.app, 2);
  });

  it("round-trips app/vms database + cluster connections through createInputToDiagram", () => {
    const { nodes, edges } = buildDiagram();
    const payload = diagramToCreateInput(nodes, edges, settings) as Record<string, unknown>;
    const rebuilt = createInputToDiagram(payload, "vm");
    const again = diagramToCreateInput(rebuilt.nodes, rebuilt.edges, settings) as Record<string, any>;
    const app = again.applications[0];
    assert.deepEqual(app.connectClusters, ["cache"]);
    assert.deepEqual(app.connectDatabases, ["sessions"]);
    assert.deepEqual(app.connectStorage, ["assets"]);
    assert.deepEqual(app.connectPubsub, ["events"]);
    assert.deepEqual(app.connectBigquery, ["analytics"]);
    assert.deepEqual(app.connectSql, ["orders"]);
    assert.deepEqual(again.vms_connect.databases, ["sessions"]);
    assert.deepEqual(again.vms_connect.sql, ["orders"]);
    assert.equal((again.storage_buckets as any[]).length, 1);
    assert.equal((again.pubsub_topics as any[]).length, 1);
    assert.equal((again.bigquery_datasets as any[]).length, 1);
    assert.equal((again.cloud_sql_instances as any[]).length, 1);
    assert.equal((again.rdi as any).name, "ingest");
    assert.equal((again.rdi as any).target, "target");
    assert.deepEqual((again.rdi as any).pipelines, [{ source: "orders" }]);
  });
});

describe("RDI connections", () => {
  it("derives rdi target + pipeline sources from edges", () => {
    const { nodes, edges } = buildDiagram();
    const payload = diagramToCreateInput(nodes, edges, settings) as Record<string, any>;
    assert.equal(payload.rdi.name, "ingest");
    assert.equal(payload.rdi.machine_type, "n2-standard-4");
    assert.equal(payload.rdi.target, "target");
    assert.deepEqual(payload.rdi.pipelines, [{ source: "orders" }]);
  });

  it("reconciles a distinct internal state DB when RDI has a target", () => {
    const { nodes, edges } = buildDiagram();
    const out = reconcileRdiInternalNodes(nodes, edges);
    assert.ok(out, "a change is produced");
    const stateNode = out!.nodes.find((n) => (n.data as any).rdiInternal);
    assert.ok(stateNode, "internal state DB spawned");
    assert.equal(stateNode!.parentId, "c1", "spawned in the target's cluster");
    const stateEdge = out!.edges.find((e) => e.id.startsWith("edge-rdiint-"));
    assert.ok(stateEdge, "distinct RDI link created");
    assert.equal(stateEdge!.className, "design-edge-rdi");
    // Second pass is a no-op (stable — no render loop).
    assert.equal(reconcileRdiInternalNodes(out!.nodes, out!.edges), null);
  });

  it("excludes the internal state DB from the create payload's databases", () => {
    const { nodes, edges } = buildDiagram();
    const withState = reconcileRdiInternalNodes(nodes, edges)!;
    const payload = diagramToCreateInput(withState.nodes, withState.edges, settings) as Record<string, any>;
    const c1 = payload.clusters.find((c: any) => c.name === "cache");
    const dbNames = (c1.databases as any[]).map((d) => d.name);
    assert.ok(!dbNames.includes("ingest-state"), "internal state DB not emitted as a user database");
  });
});

describe("exposedVariables", () => {
  it("lists the env vars each provider injects", () => {
    assert.deepEqual(
      exposedVariables("cluster", "cache").map((v) => v.name),
      ["REDIS_CACHE_HOST", "REDIS_CACHE_ADMIN_USER", "REDIS_CACHE_ADMIN_PASSWORD"],
    );
    assert.deepEqual(
      exposedVariables("database", "sessions").map((v) => v.name),
      ["REDIS_SESSIONS_ENDPOINT"],
    );
    assert.deepEqual(
      exposedVariables("loadbalancer", "front").map((v) => v.name),
      ["LB_FRONT_ENDPOINT"],
    );
    assert.deepEqual(
      exposedVariables("vms", "app").map((v) => v.name),
      ["APP_HOST"],
    );
    assert.deepEqual(
      exposedVariables("storage", "assets").map((v) => v.name),
      ["GCS_ASSETS_BUCKET", "GCS_ASSETS_URL"],
    );
    assert.deepEqual(
      exposedVariables("pubsub", "events").map((v) => v.name),
      ["PUBSUB_EVENTS_TOPIC", "PUBSUB_EVENTS_SUBSCRIPTION", "PUBSUB_EVENTS_PROJECT"],
    );
    assert.deepEqual(
      exposedVariables("bigquery", "analytics").map((v) => v.name),
      ["BIGQUERY_ANALYTICS_DATASET", "BIGQUERY_ANALYTICS_PROJECT", "BIGQUERY_ANALYTICS_LOCATION"],
    );
    assert.deepEqual(
      exposedVariables("cloudsql", "orders").map((v) => v.name),
      [
        "SQL_ORDERS_HOST",
        "SQL_ORDERS_PORT",
        "SQL_ORDERS_DB",
        "SQL_ORDERS_USER",
        "SQL_ORDERS_PASSWORD",
        "SQL_ORDERS_CONNECTION_NAME",
      ],
    );
    assert.deepEqual(
      exposedVariables("rdi", "ingest").map((v) => v.name),
      [],
    );
  });
});
