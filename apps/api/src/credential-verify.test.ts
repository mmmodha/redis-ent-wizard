import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseServiceAccountJson,
  buildPermissionReport,
  guideForPermission,
  recommendedRoles,
  ROLE_SETS,
  REQUIRED_PERMISSIONS,
} from "./credential-verify.js";

describe("parseServiceAccountJson", () => {
  it("rejects non-JSON and non-service-account keys", () => {
    assert.throws(() => parseServiceAccountJson("not-json"), /valid JSON/);
    assert.throws(
      () => parseServiceAccountJson(JSON.stringify({ type: "authorized_user" })),
      /service_account/,
    );
  });

  it("accepts a minimal service account key", () => {
    const key = parseServiceAccountJson(
      JSON.stringify({
        type: "service_account",
        project_id: "demo",
        client_email: "sa@demo.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    );
    assert.equal(key.project_id, "demo");
    assert.equal(key.client_email, "sa@demo.iam.gserviceaccount.com");
  });
});

describe("guideForPermission", () => {
  it("recommends least-privilege roles for create-time needs", () => {
    assert.match(guideForPermission("resourcemanager.projects.get"), /roles\/browser/);
    assert.doesNotMatch(guideForPermission("resourcemanager.projects.get"), /roles\/viewer/);
    assert.match(guideForPermission("compute.instances.create"), /roles\/compute\.instanceAdmin\.v1/);
    assert.doesNotMatch(guideForPermission("compute.instances.create"), /roles\/compute\.admin/);
    assert.match(guideForPermission("compute.firewalls.create"), /roles\/compute\.networkAdmin/);
    assert.match(guideForPermission("container.clusters.get"), /roles\/container\.clusterViewer/);
    assert.match(guideForPermission("container.clusters.create"), /roles\/container\.clusterAdmin/);
    assert.match(guideForPermission("dns.resourceRecordSets.create"), /roles\/dns\.admin/);
  });

  it("scopes serviceAccountUser to the node SA, not the whole project", () => {
    const g = guideForPermission(
      "iam.serviceAccounts.actAs",
      "central-beach-194106",
      "sa@central-beach-194106.iam.gserviceaccount.com",
    );
    assert.match(g, /service-accounts add-iam-policy-binding/);
    assert.match(g, /compute@developer\.gserviceaccount\.com|node service account/i);
    assert.doesNotMatch(g, /projects add-iam-policy-binding.*serviceAccountUser/s);
  });
});

describe("recommendedRoles", () => {
  it("keeps split Compute roles instead of collapsing to compute.admin", () => {
    const roles = recommendedRoles([
      "compute.networks.create",
      "compute.subnetworks.create",
      "compute.firewalls.create",
      "compute.instances.create",
      "compute.disks.create",
    ]);
    assert.ok(roles.includes("roles/compute.networkAdmin"));
    assert.ok(roles.includes("roles/compute.instanceAdmin.v1"));
    assert.ok(!roles.includes("roles/compute.admin"));
    assert.ok(!roles.includes("roles/compute.securityAdmin"));
    assert.ok(!roles.includes("roles/compute.storageAdmin"));
  });

  it("returns the documented least-privilege sets for full VM / GKE gaps", () => {
    const vmMissing = REQUIRED_PERMISSIONS.filter(
      (p) => p.modes.includes("vm") || p.modes.includes("shared"),
    ).map((p) => p.permission);
    assert.deepEqual(recommendedRoles(vmMissing).sort(), [...ROLE_SETS.vm].sort());

    const gkeMissing = REQUIRED_PERMISSIONS.filter(
      (p) => p.modes.includes("gke") || p.modes.includes("shared"),
    ).map((p) => p.permission);
    assert.deepEqual(recommendedRoles(gkeMissing).sort(), [...ROLE_SETS.gke].sort());
  });
});

describe("buildPermissionReport", () => {
  it("marks VM ready when compute+dns permissions are granted", () => {
    const granted = new Set(
      REQUIRED_PERMISSIONS.filter((p) => p.modes.includes("vm") || p.modes.includes("shared")).map(
        (p) => p.permission,
      ),
    );
    const report = buildPermissionReport(granted);
    assert.equal(report.modes.vm.ok, true);
    assert.equal(report.modes.gke.ok, false);
    assert.ok(report.modes.gke.missing.includes("container.clusters.create"));
  });

  it("attaches a fix guide when a permission is missing", () => {
    const report = buildPermissionReport(new Set(["resourcemanager.projects.get"]));
    const compute = report.checks.find((c) => c.permission === "compute.instances.create");
    assert.ok(compute);
    assert.equal(compute.level, "fail");
    assert.match(compute.guide || "", /gcloud projects add-iam-policy-binding/);
    assert.match(compute.guide || "", /instanceAdmin\.v1/);
  });
});
