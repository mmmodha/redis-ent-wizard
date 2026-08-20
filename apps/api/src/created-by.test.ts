import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gcpOwnerLabel,
  gcpResourceLabels,
  isValidCreatedBy,
  resolveCreatedBy,
} from "./created-by.js";

const localDev = { email: "dev@localhost", name: "Local Dev" };

describe("isValidCreatedBy", () => {
  it("accepts firstName_lastName and lowercases it", () => {
    assert.equal(isValidCreatedBy("mehul_modha"), true);
    assert.equal(isValidCreatedBy("Mehul_Modha"), true);
    assert.equal(isValidCreatedBy("  ANN_LEE  "), true);
  });

  it("rejects emails, spaces, hyphens, and single tokens", () => {
    assert.equal(isValidCreatedBy("mehul.modha@redis.com"), false);
    assert.equal(isValidCreatedBy("Mehul Modha"), false);
    assert.equal(isValidCreatedBy("mehul-modha"), false);
    assert.equal(isValidCreatedBy("mehul"), false);
    assert.equal(isValidCreatedBy("mehul_modha_extra"), false);
    assert.equal(isValidCreatedBy("dev@localhost"), false);
    assert.equal(isValidCreatedBy("local-devhost"), false);
    assert.equal(isValidCreatedBy(""), false);
  });
});

describe("resolveCreatedBy", () => {
  it("canonicalises Created by to firstName_lastName for the GCP owner label", () => {
    assert.equal(resolveCreatedBy("Mehul_Modha", localDev), "mehul_modha");
    assert.equal(resolveCreatedBy("mehul_modha", localDev), "mehul_modha");
  });

  it("does not use the logged-in email or name as owner", () => {
    assert.equal(resolveCreatedBy("mehul_modha", { email: "alice@redis.com", name: "Alice" }), "mehul_modha");
    assert.equal(resolveCreatedBy("", { email: "alice@redis.com", name: "Alice" }), "");
    assert.equal(resolveCreatedBy("alice@redis.com", { email: "alice@redis.com", name: "Alice" }), "");
    assert.equal(resolveCreatedBy("", localDev), "");
  });
});

describe("gcpOwnerLabel", () => {
  it("is the Created by value, already in firstName_lastName form", () => {
    assert.equal(gcpOwnerLabel("Mehul_Modha"), "mehul_modha");
    assert.equal(gcpOwnerLabel("mehul_modha"), "mehul_modha");
  });
});

describe("gcpResourceLabels", () => {
  it("always sets owner and adds skip_deletion=yes only when requested", () => {
    assert.deepEqual(gcpResourceLabels({ owner: "Mehul_Modha", skipDeletion: false }), {
      owner: "mehul_modha",
    });
    assert.deepEqual(gcpResourceLabels({ owner: "mehul_modha", skipDeletion: true }), {
      owner: "mehul_modha",
      skip_deletion: "yes",
    });
  });
});
