import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketFullName, bucketGrantRole, normalizeBucketName, normalizeStorageBuckets } from "./storage.js";

describe("normalizeBucketName", () => {
  it("slugifies and validates", () => {
    assert.equal(normalizeBucketName("My Assets"), "my-assets");
    assert.throws(() => normalizeBucketName(""), /required/);
    assert.throws(() => normalizeBucketName("1bucket"), /start with a letter/);
    assert.throws(() => normalizeBucketName("google-x"), /google/);
  });
});

describe("bucketFullName", () => {
  it("prefixes with the deployment prefix", () => {
    assert.equal(bucketFullName("demo-default", "assets"), "demo-default-assets");
  });
});

describe("bucketGrantRole", () => {
  it("maps access to a bucket IAM role", () => {
    assert.equal(bucketGrantRole("readwrite"), "roles/storage.objectAdmin");
    assert.equal(bucketGrantRole("read"), "roles/storage.objectViewer");
  });
});

describe("normalizeStorageBuckets", () => {
  it("applies defaults and rejects duplicates", () => {
    const out = normalizeStorageBuckets({
      storage_buckets: [{ name: "Assets" }, { name: "logs", access: "read", versioning: true, force_destroy: false }],
    });
    assert.deepEqual(out[0], {
      name: "assets",
      location: "",
      storage_class: "STANDARD",
      versioning: false,
      force_destroy: true,
      access: "readwrite",
    });
    assert.equal(out[1].access, "read");
    assert.equal(out[1].versioning, true);
    assert.equal(out[1].force_destroy, false);
    assert.throws(
      () => normalizeStorageBuckets({ storage_buckets: [{ name: "dup" }, { name: "dup" }] }),
      /unique/,
    );
  });
});
