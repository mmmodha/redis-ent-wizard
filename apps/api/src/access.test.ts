import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAccessView } from "./access.js";

const multiClusterEndpoints = {
  admin_username: "admin@redis.io",
  admin_password: "first-pass",
  how_to_ssh: "gcloud compute ssh test-mehul-1 --zone europe-west1-b",
  rs_ui_dns: [
    "https://node1.test-mehul.demo.redislabs.com:8443",
    "https://cluster.test-mehul.demo.redislabs.com:8443",
  ],
  rs_cluster_dns: "cluster.test-mehul.demo.redislabs.com",
  nodes_ip: ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"],
  clusters: [
    {
      index: 1,
      name_prefix: "test-mehul",
      nodes: 1,
      machine_type: "e2-standard-2",
      ui: "https://1.1.1.1:8443",
      dns: "cluster.test-mehul.demo.redislabs.com",
      nodes_ip: ["1.1.1.1"],
      node1_name: "test-mehul-1",
      admin_password: "first-pass",
    },
    {
      index: 2,
      name_prefix: "test-mehul-c2",
      nodes: 3,
      machine_type: "e2-highcpu-4",
      ui: "https://2.2.2.2:8443",
      dns: "cluster.test-mehul-c2.demo.redislabs.com",
      nodes_ip: ["2.2.2.2", "3.3.3.3", "4.4.4.4"],
      node1_name: "test-mehul-c2-1",
      admin_password: "second-pass",
    },
  ],
  app_names: ["test-mehul-app", "test-mehul-app-1"],
  app_machine_types: ["n2-highcpu-2", "n2-standard-4"],
  app_ips: ["9.9.9.9", "8.8.8.8"],
  app_dns: ["app.test-mehul.demo.redislabs.com", "app.test-mehul-1.demo.redislabs.com"],
  how_to_ssh_to_app: "gcloud compute ssh test-mehul-app",
  app_http_url: "http://app.test-mehul.demo.redislabs.com",
};

describe("buildAccessView", () => {
  it("exposes each Redis cluster with DNS, node IPs, SSH, and machine type", () => {
    const view = buildAccessView(multiClusterEndpoints, {
      region: "europe-west1",
      region_zones: ["b", "c", "d"],
    });

    assert.equal(view.clusters.length, 2);

    const c1 = view.clusters[0];
    assert.equal(c1.label, "Cluster 1");
    assert.equal(c1.machineType, "e2-standard-2");
    assert.equal(c1.clusterDns, "cluster.test-mehul.demo.redislabs.com");
    assert.equal(c1.uiUrl, "https://node1.test-mehul.demo.redislabs.com:8443");
    assert.equal(c1.uiIpUrl, "https://1.1.1.1:8443");
    assert.equal(c1.adminPassword, "first-pass");
    assert.equal(c1.nodes.length, 1);
    assert.equal(c1.nodes[0].ip, "1.1.1.1");
    assert.equal(c1.nodes[0].dns, "node1.test-mehul.demo.redislabs.com");
    assert.equal(c1.nodes[0].name, "test-mehul-1");
    assert.equal(c1.nodes[0].ssh, "gcloud compute ssh test-mehul-1 --zone europe-west1-b");
    assert.equal(c1.nodes[0].machineType, "e2-standard-2");

    const c2 = view.clusters[1];
    assert.equal(c2.label, "Cluster 2");
    assert.equal(c2.machineType, "e2-highcpu-4");
    assert.equal(c2.clusterDns, "cluster.test-mehul-c2.demo.redislabs.com");
    assert.equal(c2.uiUrl, "https://node1.test-mehul-c2.demo.redislabs.com:8443");
    assert.equal(c2.uiIpUrl, "https://2.2.2.2:8443");
    assert.equal(c2.adminPassword, "second-pass");
    assert.deepEqual(
      c2.nodes.map((n) => n.ip),
      ["2.2.2.2", "3.3.3.3", "4.4.4.4"],
    );
    assert.equal(c2.nodes[0].name, "test-mehul-c2-1");
    assert.equal(c2.nodes[1].name, "test-mehul-c2-2");
    assert.equal(c2.nodes[2].name, "test-mehul-c2-3");
    assert.equal(c2.nodes[0].ssh, "gcloud compute ssh test-mehul-c2-1 --zone europe-west1-b");
    assert.equal(c2.nodes[1].ssh, "gcloud compute ssh test-mehul-c2-2 --zone europe-west1-c");
    assert.equal(c2.nodes[2].ssh, "gcloud compute ssh test-mehul-c2-3 --zone europe-west1-d");
    assert.equal(c2.nodes[1].dns, "node2.test-mehul-c2.demo.redislabs.com");
  });

  it("never uses the cluster NS name as the browser UI link", () => {
    const view = buildAccessView(multiClusterEndpoints, {
      region: "europe-west1",
      region_zones: ["b"],
    });
    for (const cluster of view.clusters) {
      assert.ok(!cluster.uiUrl.includes("://cluster."));
      assert.ok(cluster.uiUrl.endsWith(":8443"));
      assert.ok(!cluster.clusterDns.startsWith("http"));
    }
  });

  it("exposes each App VM with DNS, IP, SSH, and machine type", () => {
    const view = buildAccessView(multiClusterEndpoints, {
      region: "europe-west1",
      region_zones: ["b", "c"],
    });
    assert.equal(view.apps.length, 2);
    assert.equal(view.apps[0].dns, "app.test-mehul.demo.redislabs.com");
    assert.equal(view.apps[0].ip, "9.9.9.9");
    assert.equal(view.apps[0].machineType, "n2-highcpu-2");
    assert.equal(view.apps[0].ssh, "gcloud compute ssh test-mehul-app --zone europe-west1-b");
    assert.equal(view.apps[0].httpUrl, "http://app.test-mehul.demo.redislabs.com");
    assert.equal(view.apps[1].name, "test-mehul-app-1");
    assert.equal(view.apps[1].machineType, "n2-standard-4");
    assert.equal(view.apps[1].ssh, "gcloud compute ssh test-mehul-app-1 --zone europe-west1-b");
  });

  it("prefers per-node terraform fields when present", () => {
    const view = buildAccessView(
      {
        admin_username: "admin@redis.io",
        clusters: [
          {
            index: 1,
            name_prefix: "demo",
            nodes: 2,
            machine_type: "e2-standard-2",
            dns: "cluster.demo.example.com",
            ui: "https://10.0.0.1:8443",
            nodes_ip: ["10.0.0.1", "10.0.0.2"],
            nodes_dns: ["node1.demo.example.com.", "node2.demo.example.com."],
            node_names: ["demo-1", "demo-2"],
            node_zones: ["us-central1-a", "us-central1-b"],
            how_to_ssh: [
              "gcloud compute ssh demo-1 --zone us-central1-a",
              "gcloud compute ssh demo-2 --zone us-central1-b",
            ],
            admin_password: "pw",
          },
        ],
      },
      { region: "us-central1", region_zones: ["f"] },
    );
    assert.equal(view.clusters[0].nodes[1].zone, "us-central1-b");
    assert.equal(view.clusters[0].nodes[1].ssh, "gcloud compute ssh demo-2 --zone us-central1-b");
    assert.equal(view.clusters[0].nodes[1].dns, "node2.demo.example.com");
  });

  it("falls back to flattened single-cluster outputs", () => {
    const view = buildAccessView(
      {
        admin_username: "admin@redis.io",
        admin_password: "solo",
        rs_cluster_dns: "cluster.solo.demo.redislabs.com",
        rs_ui_ip: "https://5.5.5.5:8443",
        nodes_ip: ["5.5.5.5", "6.6.6.6"],
        nodes_dns: ["node1.solo.demo.redislabs.com.", "node2.solo.demo.redislabs.com."],
        how_to_ssh: "gcloud compute ssh solo-1 --zone europe-west1-b",
      },
      { region: "europe-west1", region_zones: ["b", "c"], machine_type: "e2-standard-2" },
    );
    assert.equal(view.clusters.length, 1);
    assert.equal(view.clusters[0].uiUrl, "https://node1.solo.demo.redislabs.com:8443");
    assert.equal(view.clusters[0].nodes[1].ip, "6.6.6.6");
    assert.equal(view.clusters[0].nodes[1].ssh, "gcloud compute ssh solo-2 --zone europe-west1-c");
  });

  it("uses per-app terraform objects and SSH lists", () => {
    const view = buildAccessView(
      {
        apps: [
          {
            name: "demo-app",
            machine_type: "n2-highcpu-2",
            ip: "7.7.7.7",
            dns: "app.demo.example.com.",
            zone: "europe-west1-b",
            how_to_ssh: "gcloud compute ssh demo-app --zone europe-west1-b",
          },
        ],
        how_to_ssh_to_app: [
          "gcloud compute ssh demo-app --zone europe-west1-b",
          "gcloud compute ssh demo-app-1 --zone europe-west1-b",
        ],
        app_names: ["demo-app", "demo-app-1"],
        app_ips: ["7.7.7.7", "6.6.6.6"],
        app_dns: ["app.demo.example.com", "app.demo-1.example.com"],
        app_machine_types: ["n2-highcpu-2", "e2-standard-2"],
      },
      { region: "europe-west1", region_zones: ["b"] },
    );
    assert.equal(view.apps[0].dns, "app.demo.example.com");
    assert.equal(view.apps[0].ssh, "gcloud compute ssh demo-app --zone europe-west1-b");
    assert.equal(view.apps[1].ssh, "gcloud compute ssh demo-app-1 --zone europe-west1-b");
    assert.ok(!view.apps[1].ssh.includes(","));
  });

  it("maps GKE REC outputs into cluster cards with UI URLs", () => {
    const view = buildAccessView(
      {
        how_to_kubectl: "gcloud container clusters get-credentials demo --zone europe-west1-b",
        recs: [
          {
            name: "demo-rec",
            ui: "https://10.1.1.1:8443",
            admin_username: "admin@redis.io",
            admin_password: "gke-one",
          },
          {
            name: "demo-rec-c2",
            ui: "https://10.1.1.2:8443",
            admin_username: "admin@redis.io",
            admin_password: "gke-two",
          },
        ],
      },
      { mode: "gke" },
    );
    assert.equal(view.clusters.length, 2);
    assert.equal(view.clusters[1].label, "demo-rec-c2");
    assert.equal(view.clusters[1].uiUrl, "https://10.1.1.2:8443");
    assert.equal(view.kubectl, "gcloud container clusters get-credentials demo --zone europe-west1-b");
  });
});
