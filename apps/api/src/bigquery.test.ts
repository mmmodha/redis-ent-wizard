import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { datasetFullId, datasetGrantRole, normalizeBigquery, normalizeDatasetName } from "./bigquery.js";

describe("normalizeDatasetName", () => {
  it("slugifies with underscores and validates", () => {
    assert.equal(normalizeDatasetName("My Analytics"), "my_analytics");
    assert.throws(() => normalizeDatasetName(""), /required/);
    assert.throws(() => normalizeDatasetName("1ds"), /start with a letter/);
  });
});

describe("datasetFullId", () => {
  it("prefixes with underscores (hyphens converted)", () => {
    assert.equal(datasetFullId("demo-default", "analytics"), "demo_default_analytics");
  });
});

describe("datasetGrantRole", () => {
  it("maps access to a dataset role", () => {
    assert.equal(datasetGrantRole("readwrite"), "roles/bigquery.dataEditor");
    assert.equal(datasetGrantRole("read"), "roles/bigquery.dataViewer");
  });
});

describe("normalizeBigquery", () => {
  it("applies defaults and rejects duplicates", () => {
    const out = normalizeBigquery({ bigquery_datasets: [{ name: "Analytics" }, { name: "logs", access: "read" }] });
    assert.deepEqual(out[0], { name: "analytics", location: "", access: "readwrite" });
    assert.equal(out[1].access, "read");
    assert.throws(() => normalizeBigquery({ bigquery_datasets: [{ name: "d" }, { name: "d" }] }), /unique/);
  });
});
