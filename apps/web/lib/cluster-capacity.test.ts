import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clusterCapacityCaption,
  clusterCapacityClass,
  gcpProbeZone,
  instanceCredentialsRef,
} from "./cluster-capacity.js";

describe("clusterCapacityCaption", () => {
  it("shows remaining RAM once the machine-type catalog is available", () => {
    assert.equal(
      clusterCapacityCaption({ catalogReady: true, remainingMB: 3072, ifUnavailable: "pending" }),
      "free 3 GB",
    );
    assert.equal(
      clusterCapacityCaption({ catalogReady: true, remainingMB: -2048, ifUnavailable: "hide" }),
      "over by 2 GB",
    );
  });

  it("uses a loading placeholder only while the designer waits for the catalog", () => {
    assert.equal(
      clusterCapacityCaption({ catalogReady: false, remainingMB: 0, ifUnavailable: "pending" }),
      "capacity pending",
    );
  });

  it("hides capacity on a provisioned instance until RAM specs are known", () => {
    assert.equal(
      clusterCapacityCaption({ catalogReady: false, remainingMB: 0, ifUnavailable: "hide" }),
      null,
    );
  });
});

describe("clusterCapacityClass", () => {
  it("marks leftover RAM as free so the diagram can paint it Volt", () => {
    assert.equal(
      clusterCapacityClass({ catalogReady: true, remainingMB: 1024, ifUnavailable: "pending" }),
      "design-cap-free",
    );
  });

  it("marks a shortage as over-capacity", () => {
    assert.equal(
      clusterCapacityClass({ catalogReady: true, remainingMB: -512, ifUnavailable: "pending" }),
      "design-cap-bad",
    );
  });

  it("does not color the pending placeholder", () => {
    assert.equal(
      clusterCapacityClass({ catalogReady: false, remainingMB: 0, ifUnavailable: "pending" }),
      "",
    );
  });
});

describe("gcpProbeZone", () => {
  it("appends the first zone suffix to a region", () => {
    assert.equal(gcpProbeZone("europe-west1", ["b", "c"]), "europe-west1-b");
  });

  it("defaults to zone b when suffixes are missing", () => {
    assert.equal(gcpProbeZone("us-central1"), "us-central1-b");
  });
});

describe("instanceCredentialsRef", () => {
  it("prefers the credentials id over a stored file path", () => {
    assert.equal(instanceCredentialsRef({ credentialsId: "cred-1", credentialsFile: "/data/credentials/sa.json" }), "cred-1");
  });

  it("uses the legacy filename when no id is stored", () => {
    assert.equal(instanceCredentialsRef({ credentialsFile: "/data/credentials/sa.json" }), "sa.json");
  });
});
