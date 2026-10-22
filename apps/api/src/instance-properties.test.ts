import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInstanceProperties, escapePropertyValue, type PropertiesSource } from "./instance-properties.js";

const NOW = new Date("2026-10-22T09:00:00Z");

function vmInstance(extra: Partial<PropertiesSource> = {}): PropertiesSource {
  return {
    id: "fraud-fbloop-default",
    name: "fraud-fbloop",
    mode: "vm",
    status: "ready",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-12T11:02:47Z",
    project: "central-beach-194106",
    region: "europe-west1",
    ownerEmail: "david_pinto",
    config: {
      region_zones: ["b", "c", "d"],
      machine_type: "n2d-highmem-16",
      // A user-chosen DB password in the config must never reach the file.
      clusters: [{ name: "fraud-store", databases: [{ name: "fraud", password: "USER-DB-SECRET" }] }],
    },
    endpoints: {
      rs_cluster_dns: "cluster.fraud-store.demo.redislabs.com.",
      nodes_ip: ["34.1.1.1", "34.1.1.2", "34.1.1.3"],
      nodes_dns: ["node1.x.demo.redislabs.com.", "node2.x.demo.redislabs.com.", "node3.x.demo.redislabs.com."],
      how_to_ssh: "gcloud compute ssh fraud-store-node1 --zone europe-west1-b",
      admin_username: "admin@redis.io",
      admin_password: "gen-pass-123",
      app_workloads: [
        {
          name: "fraud-engine",
          app_name: "engine",
          ip: "34.78.233.163",
          dns: "app.engine.demo.redislabs.com",
          zone: "europe-west1-b",
          ports: [8080, 8090],
          how_to_ssh: "gcloud compute ssh fraud-engine --zone europe-west1-b",
        },
      ],
      load_balancers: [{ name: "engine-lb", vip: "10.26.2.9", ports: [8080] }],
      storage_buckets: [{ name: "fraud-data", url: "gs://fraud-data", location: "EU" }],
    },
    databaseStates: [
      {
        cluster: "fraud-store",
        name: "fraud",
        status: "active",
        endpoint: "redis-6379.cluster.fraud-store.demo.redislabs.com:6379",
        port: 6379,
      },
    ],
    ...extra,
  };
}

/** Parse the output back the way a .properties loader would (enough for these keys). */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    assert.ok(i > 0, `not name=value: ${line}`);
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe("escapePropertyValue", () => {
  it("escapes backslash, control chars and non-ASCII; keeps = and : literal", () => {
    assert.equal(escapePropertyValue("a\\b"), "a\\\\b");
    assert.equal(escapePropertyValue("l1\nl2\ttab"), "l1\\nl2\\ttab");
    assert.equal(escapePropertyValue("café"), "caf\\u00e9");
    assert.equal(escapePropertyValue("k=v:w#x"), "k=v:w#x");
  });
  it("escapes a leading space so it survives loader trimming", () => {
    assert.equal(escapePropertyValue(" x"), "\\ x");
  });
  it("writes astral characters as UTF-16 surrogate escapes", () => {
    assert.equal(escapePropertyValue("😀"), "\\ud83d\\ude00");
  });
});

describe("buildInstanceProperties", () => {
  const text = buildInstanceProperties(vmInstance(), NOW);
  const p = parse(text);

  it("starts with a header, a timestamp and a credentials warning", () => {
    const lines = text.split("\n");
    assert.match(lines[0], /^# /);
    assert.match(text, /# Generated: 2026-10-22T09:00:00\.000Z/);
    assert.match(text, /# WARNING: contains credentials/);
    assert.ok(text.endsWith("\n"));
  });

  it("includes instance details", () => {
    assert.equal(p["instance.id"], "fraud-fbloop-default");
    assert.equal(p["instance.mode"], "vm");
    assert.equal(p["instance.project"], "central-beach-194106");
    assert.equal(p["instance.region"], "europe-west1");
  });

  it("includes the cluster endpoints and the generated admin credentials", () => {
    assert.equal(p["cluster.cluster-1.admin.username"], "admin@redis.io");
    assert.equal(p["cluster.cluster-1.admin.password"], "gen-pass-123");
    assert.equal(p["cluster.cluster-1.dns"], "cluster.fraud-store.demo.redislabs.com");
    assert.equal(p["cluster.cluster-1.node_count"], "3");
    assert.equal(p["cluster.cluster-1.node.2.ip"], "34.1.1.2");
  });

  it("splits a database endpoint into host and port", () => {
    assert.equal(
      p["database.fraud-store-fraud.endpoint"],
      "redis-6379.cluster.fraud-store.demo.redislabs.com:6379",
    );
    assert.equal(p["database.fraud-store-fraud.host"], "redis-6379.cluster.fraud-store.demo.redislabs.com");
    assert.equal(p["database.fraud-store-fraud.port"], "6379");
    assert.equal(p["database.fraud-store-fraud.status"], "active");
  });

  it("includes workloads, load balancers and buckets", () => {
    assert.equal(p["workload.fraud-engine.ip"], "34.78.233.163");
    assert.equal(p["workload.fraud-engine.ports"], "8080,8090");
    assert.equal(p["loadbalancer.engine-lb.vip"], "10.26.2.9");
    assert.equal(p["bucket.fraud-data.url"], "gs://fraud-data");
  });

  it("lists each workload VM once (no duplicate appvm block)", () => {
    assert.ok(!Object.keys(p).some((k) => k.startsWith("appvm.")));
  });

  it("never writes a user-chosen database password", () => {
    assert.ok(!text.includes("USER-DB-SECRET"));
    assert.ok(!Object.keys(p).some((k) => /database\..*password/.test(k)));
  });

  it("emits only valid name=value / comment / blank lines with ASCII-only content", () => {
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      assert.match(line, /^[A-Za-z0-9_.-]+=/);
    }
    assert.ok(/^[\x00-\x7f]*$/.test(text));
  });

  it("keeps keys unique when names collide", () => {
    const dup = vmInstance({
      databaseStates: [
        { cluster: "a", name: "x y", status: "active", endpoint: "h1:1" },
        { cluster: "a", name: "x_y", status: "active", endpoint: "h2:2" },
      ],
    });
    const keys = Object.keys(parse(buildInstanceProperties(dup, NOW)));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.includes("database.a-x_y.endpoint") && keys.includes("database.a-x_y-2.endpoint"));
  });

  it("escapes special characters in values", () => {
    const inst = vmInstance();
    (inst.endpoints as Record<string, unknown>).admin_password = "p@ss\\w=rd é";
    const q = parse(buildInstanceProperties(inst, NOW));
    assert.equal(q["cluster.cluster-1.admin.password"], "p@ss\\\\w=rd \\u00e9");
  });

  it("omits empty sections and values", () => {
    const empty = buildInstanceProperties(
      vmInstance({ endpoints: {}, databaseStates: [], config: {} }),
      NOW,
    );
    assert.ok(!/^# Redis cluster/m.test(empty));
    assert.doesNotMatch(empty, /=\n/);
    assert.match(empty, /^instance\.id=/m);
  });

  it("includes kubectl for GKE", () => {
    const gke = vmInstance({
      mode: "gke",
      endpoints: {
        how_to_kubectl: "gcloud container clusters get-credentials c --zone z",
        recs: [{ name: "rec1", ui: "https://35.1.1.1:8443", admin_username: "u", admin_password: "pw" }],
        rec_ui_url: "https://35.1.1.1:8443",
      },
    });
    const q = parse(buildInstanceProperties(gke, NOW));
    assert.equal(q["kubectl.command"], "gcloud container clusters get-credentials c --zone z");
    assert.equal(q["instance.mode"], "gke");
  });
});
