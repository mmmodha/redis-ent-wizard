import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saKeySetupScript } from "./sa-key-setup.js";

describe("saKeySetupScript", () => {
  it("creates a VM-ready service account key with the wizard least-privilege roles", () => {
    const script = saKeySetupScript({ projectId: "my-gcp-proj", saId: "rew-wizard" });
    assert.match(script, /gcloud config set project my-gcp-proj/);
    assert.match(script, /gcloud iam service-accounts create rew-wizard/);
    for (const role of [
      "roles/browser",
      "roles/serviceusage.serviceUsageConsumer",
      "roles/compute.viewer",
      "roles/compute.networkAdmin",
      "roles/compute.instanceAdmin.v1",
      "roles/dns.admin",
    ]) {
      assert.match(script, new RegExp(role.replace(".", "\\.")));
    }
    assert.match(script, /gcloud iam service-accounts keys create/);
    assert.match(script, /rew-wizard@my-gcp-proj\.iam\.gserviceaccount\.com/);
    assert.doesNotMatch(script, /roles\/owner/);
    assert.doesNotMatch(script, /roles\/compute\.admin/);
  });

  it("adds GKE clusterAdmin and node-SA actAs when includeGke is true", () => {
    const script = saKeySetupScript({ projectId: "my-gcp-proj", saId: "rew-wizard", includeGke: true });
    assert.match(script, /roles\/container\.clusterAdmin/);
    assert.match(script, /roles\/iam\.serviceAccountUser/);
    assert.match(script, /compute@developer\.gserviceaccount\.com/);
    assert.match(script, /container\.googleapis\.com/);
  });
});
