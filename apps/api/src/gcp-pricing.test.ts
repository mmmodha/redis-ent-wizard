import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveResource } from "./gcp-inventory.js";
import {
  familyOf,
  hoursSince,
  isSharedCore,
  priceDisk,
  priceInstance,
  priceResources,
  skuUnitPrice,
  type Sku,
} from "./gcp-pricing.js";

// Canned SKUs shaped like the real Catalog API for europe-west1.
const REGION = "europe-west1";
const sku = (
  resourceGroup: string,
  description: string,
  units: string,
  nanos: number,
): Sku => ({
  description,
  category: { resourceGroup, usageType: "OnDemand" },
  serviceRegions: [REGION],
  pricingInfo: [{ pricingExpression: { tieredRates: [{ unitPrice: { currencyCode: "USD", units, nanos } }] } }],
});

const SKUS: Sku[] = [
  sku("CPU", "E2 Instance Core running in Belgium", "0", 21811000), // $0.021811 / vCPU-hr
  sku("RAM", "E2 Instance Ram running in Belgium", "0", 2924000), //   $0.002924 / GiB-hr
  sku("SSD", "SSD backed PD Capacity in Belgium", "0", 170000000), // $0.17 / GiB-mo
  sku("PDStandard", "Storage PD Capacity in Belgium", "0", 40000000), // $0.04 / GiB-mo
  // a custom-machine SKU that must NOT be picked for predefined types
  sku("CPU", "E2 Custom Instance Core running in Belgium", "9", 0),
];

describe("skuUnitPrice / familyOf / isSharedCore", () => {
  it("reads units + nanos into a decimal", () => {
    assert.equal(skuUnitPrice(SKUS[0])?.amount, 0.021811);
  });
  it("derives the machine family", () => {
    assert.equal(familyOf("e2-standard-2"), "e2");
    assert.equal(familyOf("n2d-highmem-4"), "n2d");
  });
  it("flags shared-core types", () => {
    assert.ok(isSharedCore("e2-micro"));
    assert.ok(!isSharedCore("e2-standard-2"));
  });
});

describe("priceInstance", () => {
  it("prices a predefined VM as vCPU×core + GiB×ram, ignoring the custom SKU", () => {
    // e2-standard-2 = 2 vCPU, 8 GiB → 2*0.021811 + 8*0.002924 = 0.067014
    const p = priceInstance(
      { machineType: "e2-standard-2", guestCpus: 2, memoryMb: 8192, region: REGION },
      SKUS,
    );
    assert.ok(p);
    assert.ok(Math.abs(p!.amount - 0.067014) < 1e-9, `got ${p!.amount}`);
    assert.equal(p!.currency, "USD");
  });

  it("returns undefined for a shared-core type", () => {
    assert.equal(priceInstance({ machineType: "e2-micro", guestCpus: 2, memoryMb: 1024, region: REGION }, SKUS), undefined);
  });

  it("returns undefined for a family with no matching SKU", () => {
    assert.equal(priceInstance({ machineType: "c3-standard-4", guestCpus: 4, memoryMb: 16384, region: REGION }, SKUS), undefined);
  });

  it("returns undefined in a region with no SKU", () => {
    assert.equal(priceInstance({ machineType: "e2-standard-2", guestCpus: 2, memoryMb: 8192, region: "us-central1" }, SKUS), undefined);
  });
});

describe("priceDisk", () => {
  it("prices an SSD disk per GiB-month ÷ 730", () => {
    const p = priceDisk({ sizeGb: 100, diskType: "pd-ssd", region: REGION }, SKUS);
    assert.ok(p);
    assert.ok(Math.abs(p!.amount - (100 * 0.17) / 730) < 1e-9, `got ${p!.amount}`);
  });
  it("unpriced for an unknown disk type", () => {
    assert.equal(priceDisk({ sizeGb: 100, diskType: "pd-mystery", region: REGION }, SKUS), undefined);
  });
});

describe("hoursSince", () => {
  it("computes elapsed hours from a fixed clock", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal(hoursSince("2026-09-14T00:00:00Z", now), 24);
    assert.equal(hoursSince(undefined, now), undefined);
    assert.equal(hoursSince("not-a-date", now), undefined);
  });
});

describe("priceResources", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  const vm: LiveResource = {
    kind: "compute.instance",
    name: "demo-1",
    location: "europe-west1-b",
    creationTimestamp: "2026-09-14T00:00:00Z", // 24h ago
    attrs: { machineType: "e2-standard-2", zone: "europe-west1-b" },
  };
  const bucket: LiveResource = { kind: "storage.bucket", name: "demo-assets", location: "EU", attrs: {} };

  it("fills costPerHour + costSoFar for a VM and leaves other kinds unpriced", async () => {
    const out = await priceResources([vm, bucket], {
      skus: SKUS,
      now,
      machineType: async () => ({ guestCpus: 2, memoryMb: 8192 }),
    });
    const pricedVm = out[0];
    assert.ok(Math.abs((pricedVm.costPerHour ?? 0) - 0.067014) < 1e-9);
    assert.ok(Math.abs((pricedVm.costSoFar ?? 0) - 0.067014 * 24) < 1e-7);
    assert.equal(out[1].costPerHour, undefined); // bucket unpriced
  });

  it("leaves a VM unpriced when its machine type can't be resolved", async () => {
    const out = await priceResources([vm], { skus: SKUS, now, machineType: async () => undefined });
    assert.equal(out[0].costPerHour, undefined);
    assert.equal(out[0].costSoFar, undefined);
  });
});
