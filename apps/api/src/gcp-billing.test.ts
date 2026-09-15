import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBillingRows } from "./gcp-billing.js";

describe("parseBillingRows", () => {
  const schema = { fields: [{ name: "name" }, { name: "cost" }, { name: "currency" }] };

  it("sums cost per resource short-name and reads the currency", () => {
    const { byName, currency } = parseBillingRows({
      jobComplete: true,
      schema,
      rows: [
        { f: [{ v: "demo-default-1" }, { v: "12.5" }, { v: "USD" }] },
        { f: [{ v: "//compute.googleapis.com/projects/p/zones/z/instances/demo-default-2" }, { v: "3.25" }, { v: "USD" }] },
        { f: [{ v: "demo-default-1" }, { v: "0.5" }, { v: "USD" }] }, // same resource again → summed
      ],
    });
    assert.equal(byName.get("demo-default-1"), 13);
    assert.equal(byName.get("demo-default-2"), 3.25); // keyed by last path segment
    assert.equal(currency, "USD");
  });

  it("returns an empty map when the schema lacks name/cost", () => {
    const { byName } = parseBillingRows({ jobComplete: true, schema: { fields: [{ name: "foo" }] }, rows: [] });
    assert.equal(byName.size, 0);
  });

  it("skips rows with no resource name", () => {
    const { byName } = parseBillingRows({
      jobComplete: true,
      schema,
      rows: [{ f: [{ v: null }, { v: "9" }, { v: "USD" }] }],
    });
    assert.equal(byName.size, 0);
  });
});
