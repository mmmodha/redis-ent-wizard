import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapBigqueryDataset,
  mapBucket,
  mapComputeInstance,
  mapDisk,
  mapDnsRecord,
  mapGkeCluster,
  mapPubsubTopic,
  mapSqlInstance,
  regionFromZone,
  tail,
} from "./gcp-inventory.js";

describe("helpers", () => {
  it("tail takes the last path segment", () => {
    assert.equal(tail("https://.../zones/europe-west1-b/machineTypes/e2-standard-2"), "e2-standard-2");
    assert.equal(tail(undefined), "");
  });
  it("regionFromZone strips the zone suffix", () => {
    assert.equal(regionFromZone("europe-west1-b"), "europe-west1");
    assert.equal(regionFromZone("europe-west1"), "europe-west1"); // already a region
  });
});

describe("compute mappers", () => {
  it("normalizes a compute instance and its owner label", () => {
    const r = mapComputeInstance({
      name: "demo-default-1",
      zone: "https://www.googleapis.com/compute/v1/projects/p/zones/europe-west1-b",
      status: "RUNNING",
      creationTimestamp: "2026-09-01T00:00:00Z",
      machineType: "https://www.googleapis.com/compute/v1/projects/p/zones/europe-west1-b/machineTypes/e2-standard-2",
      labels: { owner: "jane_doe", skip_deletion: "yes" },
    });
    assert.equal(r.kind, "compute.instance");
    assert.equal(r.location, "europe-west1-b");
    assert.equal(r.attrs.machineType, "e2-standard-2");
    assert.equal(r.owner, "jane_doe");
    assert.equal(r.creationTimestamp, "2026-09-01T00:00:00Z");
  });

  it("normalizes a disk with numeric sizeGb and type", () => {
    const r = mapDisk({
      name: "demo-default-app-data-0",
      zone: ".../zones/europe-west1-b",
      sizeGb: "100",
      type: ".../diskTypes/pd-ssd",
      status: "READY",
    });
    assert.equal(r.attrs.sizeGb, 100);
    assert.equal(r.attrs.diskType, "pd-ssd");
    assert.equal(r.location, "europe-west1-b");
  });
});

describe("data-service mappers", () => {
  it("maps a Cloud SQL instance with created_by label and tier", () => {
    const r = mapSqlInstance({
      name: "demo-default-orders",
      region: "europe-west1",
      state: "RUNNABLE",
      createTime: "2026-09-01T00:00:00Z",
      databaseVersion: "POSTGRES_15",
      settings: { tier: "db-custom-2-7680", dataDiskSizeGb: "20" },
      userLabels: { created_by: "jane_doe" },
    });
    assert.equal(r.kind, "sql.instance");
    assert.equal(r.attrs.tier, "db-custom-2-7680");
    assert.equal(r.attrs.dataDiskSizeGb, 20);
    assert.equal(r.owner, "jane_doe");
  });

  it("maps a GKE cluster with node pools", () => {
    const r = mapGkeCluster({
      name: "demo-default-gke",
      location: "europe-west1",
      status: "RUNNING",
      createTime: "2026-09-01T00:00:00Z",
      currentNodeCount: 3,
      nodePools: [{ name: "default", config: { machineType: "e2-standard-8" }, initialNodeCount: 3 }],
      resourceLabels: { owner: "jane_doe" },
    });
    assert.equal(r.kind, "gke.cluster");
    assert.equal(r.attrs.nodeCount, 3);
    assert.deepEqual((r.attrs.nodePools as unknown[])[0], {
      name: "default",
      machineType: "e2-standard-8",
      nodeCount: 3,
    });
  });

  it("maps a bucket, pubsub topic (short name), bigquery dataset, dns record", () => {
    assert.equal(mapBucket({ name: "demo-default-assets", location: "EU", storageClass: "STANDARD" }).location, "EU");
    assert.equal(mapPubsubTopic({ name: "projects/p/topics/demo-default-events" }).name, "demo-default-events");
    assert.equal(
      mapBigqueryDataset({ datasetReference: { datasetId: "demo_default_analytics" }, location: "EU" }).name,
      "demo_default_analytics",
    );
    const dns = mapDnsRecord({ name: "cluster.demo-default.demo.example.com.", type: "A", ttl: 300 }, "demo-clusters");
    assert.equal(dns.name, "cluster.demo-default.demo.example.com");
    assert.equal(dns.location, "demo-clusters");
  });
});
