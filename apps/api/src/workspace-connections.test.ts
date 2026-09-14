import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVmRegistry, resolveVmConnections, resolveGkeConnections } from "./workspace.js";
import { normalizeClusters } from "./clusters.js";
import type { CreateInstanceInput } from "./types.js";

const baseInput = (): CreateInstanceInput => ({
  name: "demo",
  mode: "vm",
  youremail: "jane_doe",
  project: "proj",
  credentialsFile: "key.json",
  env: "default",
  RS_admin: "admin@redis.io",
  dns_zone_dns_name: "demo.redislabs.com",
  app: 2,
  clusters: [
    { name: "cache", nodes: 3, databases: [{ name: "sessions", memory_gb: 1, port: 12000 }] },
  ],
  applications: [
    { name: "web", artifact: { kind: "url", ref: "https://x/app.jar", type: "jar" } },
  ],
  load_balancers: [{ name: "front", target: "web", target_kind: "application", ports: [8080] }],
  storage_buckets: [{ name: "assets", access: "readwrite" }],
  pubsub_topics: [{ name: "events", create_subscription: true, role: "both" }],
  bigquery_datasets: [{ name: "analytics", access: "readwrite" }],
});

describe("resolveVmConnections", () => {
  it("injects static host/db/app env and records apply-time refs", () => {
    const input = baseInput();
    const clusters = normalizeClusters(input);
    const reg = buildVmRegistry(input, clusters, "demo-default", "demo.redislabs.com");
    const conn = resolveVmConnections(
      {
        connectClusters: ["cache"],
        connectDatabases: ["sessions"],
        connectLoadBalancers: ["front"],
        connectApps: ["web"],
        connectStorage: ["assets"],
        connectPubsub: ["events"],
        connectBigquery: ["analytics"],
      },
      reg,
    );
    assert.equal(conn.env.REDIS_CACHE_HOST, "cluster.demo-default-cache.demo.redislabs.com");
    assert.equal(conn.env.GCS_ASSETS_BUCKET, "demo-default-assets");
    assert.equal(conn.env.GCS_ASSETS_URL, "gs://demo-default-assets");
    assert.equal(conn.env.PUBSUB_EVENTS_TOPIC, "projects/proj/topics/demo-default-events");
    assert.equal(conn.env.PUBSUB_EVENTS_SUBSCRIPTION, "projects/proj/subscriptions/demo-default-events-sub");
    assert.equal(conn.env.PUBSUB_EVENTS_PROJECT, "proj");
    assert.equal(conn.env.BIGQUERY_ANALYTICS_DATASET, "demo_default_analytics");
    assert.equal(conn.env.BIGQUERY_ANALYTICS_PROJECT, "proj");
    assert.equal(conn.env.REDIS_CACHE_ADMIN_USER, "admin@redis.io");
    assert.equal(conn.env.REDIS_HOST, "cluster.demo-default-cache.demo.redislabs.com");
    assert.equal(
      conn.env.REDIS_SESSIONS_ENDPOINT,
      "redis-12000.cluster.demo-default-cache.demo.redislabs.com:12000",
    );
    assert.equal(conn.env.WEB_HOST, "web.demo-default.demo.redislabs.com");
    // Admin password is not static — it becomes a Terraform reference (re_vm index).
    assert.equal(conn.env.REDIS_CACHE_ADMIN_PASSWORD, undefined);
    assert.deepEqual(conn.connectClusterAdmin, { REDIS_CACHE_ADMIN_PASSWORD: 0 });
    assert.deepEqual(conn.connectLb, { LB_FRONT_ENDPOINT: "front" });
  });

  it("resolves an unknown connectApps name to the Set-of-VMs group host", () => {
    const input = baseInput();
    const reg = buildVmRegistry(input, normalizeClusters(input), "demo-default", "demo.redislabs.com");
    const conn = resolveVmConnections({ connectApps: ["app"] }, reg);
    assert.equal(conn.env.APP_HOST, "app.demo-default.demo.redislabs.com");
  });
});

describe("resolveGkeConnections", () => {
  it("uses in-cluster DNS and optional secret refs for admin creds", () => {
    const input: CreateInstanceInput = {
      ...baseInput(),
      mode: "gke",
      applications: [{ name: "web", image: "nginx" }],
    };
    const clusters = normalizeClusters({ ...input, mode: "gke" });
    const { env, secretRefs } = resolveGkeConnections(
      { connectClusters: ["cache"], connectDatabases: ["sessions"], connectApps: ["web"] },
      clusters,
      "demo-default",
      ["web"],
    );
    assert.equal(env.REDIS_CACHE_HOST, "demo-default-cache-rec.rec-ns.svc.cluster.local");
    assert.equal(env.REDIS_SESSIONS_ENDPOINT, "sessions.rec-ns.svc.cluster.local:12000");
    assert.equal(env.WEB_HOST, "web.apps.svc.cluster.local");
    assert.deepEqual(
      secretRefs.map((r) => `${r.name}:${r.secret}:${r.key}`),
      [
        "REDIS_CACHE_ADMIN_USER:demo-default-cache-rec:username",
        "REDIS_CACHE_ADMIN_PASSWORD:demo-default-cache-rec:password",
      ],
    );
  });
});
