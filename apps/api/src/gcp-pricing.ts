import { gcpGetAll } from "./gcp.js";
import { mapWithConcurrency } from "./async-util.js";
import type { LiveResource } from "./gcp-inventory.js";

/**
 * cost/hour from the Cloud Billing **Catalog API** (public list prices).
 *
 * This is a deliberate estimate, not a bill: it ignores sustained-use and
 * committed-use discounts, negotiated rates, egress, and actual utilization.
 * The mapping from a resource to its SKUs is inherently fuzzy, so anything we
 * cannot confidently price is left **undefined** (shown as "—") rather than
 * guessed. v1 prices Compute VMs (vCPU + RAM) and persistent disks; other
 * resource types are intentionally left unpriced.
 */

const COMPUTE_SERVICE = "6F81-5844-456A"; // Compute Engine
const HOURS_PER_MONTH = 730;
const SKU_TTL_MS = 24 * 60 * 60_000;

export interface Sku {
  skuId?: string;
  description?: string;
  category?: { resourceFamily?: string; resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: Array<{
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: Array<{ unitPrice?: { currencyCode?: string; units?: string; nanos?: number } }>;
    };
  }>;
}

export interface Money {
  amount: number;
  currency: string;
}

/** Latest tiered unit price of a SKU as a decimal amount + currency. */
export function skuUnitPrice(sku: Sku): Money | undefined {
  const expr = sku.pricingInfo?.[sku.pricingInfo.length - 1]?.pricingExpression;
  const tier = expr?.tieredRates?.[expr.tieredRates.length - 1]?.unitPrice;
  if (!tier) return undefined;
  const amount = (Number(tier.units) || 0) + (tier.nanos || 0) / 1e9;
  return { amount, currency: tier.currencyCode || "USD" };
}

/** Machine-type family, e.g. "e2-standard-2" → "e2", "n2d-highmem-4" → "n2d". */
export function familyOf(machineType: string): string {
  return (machineType.split("-")[0] || "").toLowerCase();
}

/** Shared-core types are priced as a single bundled SKU we don't model yet. */
export function isSharedCore(machineType: string): boolean {
  return /^(e2-(micro|small|medium)|f1-micro|g1-small)$/.test(machineType);
}

// Family → the token that appears in its CPU/RAM SKU descriptions. Best-effort;
// a miss yields "unpriced", never a wrong price.
const FAMILY_TOKEN: Record<string, string> = {
  e2: "E2 Instance",
  n1: "N1 Predefined Instance",
  n2: "N2 Instance",
  n2d: "N2D AMD Instance",
  n4: "N4 Instance",
  c2: "Compute optimized",
  c2d: "C2D AMD Instance",
  c3: "C3 Instance",
  c3d: "C3D Instance",
  t2d: "T2D AMD Instance",
  t2a: "T2A Arm Instance",
  m1: "Memory-optimized Instance",
  m2: "Memory-optimized Instance",
};

function findRate(skus: Sku[], region: string, resourceGroup: "CPU" | "RAM", token: string): Money | undefined {
  const t = token.toLowerCase();
  const sku = skus.find(
    (s) =>
      s.category?.resourceGroup === resourceGroup &&
      s.category?.usageType === "OnDemand" &&
      (s.serviceRegions || []).includes(region) &&
      (s.description || "").toLowerCase().includes(t) &&
      // exclude custom-machine-type SKUs when pricing predefined types
      !(s.description || "").toLowerCase().includes("custom"),
  );
  return sku ? skuUnitPrice(sku) : undefined;
}

/** Hourly cost of a predefined VM = vCPUs × core-rate + GiB × ram-rate. */
export function priceInstance(
  opts: { machineType: string; guestCpus: number; memoryMb: number; region: string },
  skus: Sku[],
): Money | undefined {
  if (isSharedCore(opts.machineType)) return undefined;
  const token = FAMILY_TOKEN[familyOf(opts.machineType)];
  if (!token) return undefined;
  const core = findRate(skus, opts.region, "CPU", token);
  const ram = findRate(skus, opts.region, "RAM", token);
  if (!core || !ram) return undefined;
  const gib = opts.memoryMb / 1024;
  return { amount: opts.guestCpus * core.amount + gib * ram.amount, currency: core.currency };
}

// Disk type → Catalog resourceGroup.
const DISK_GROUP: Record<string, string> = {
  "pd-standard": "PDStandard",
  "pd-ssd": "SSD",
  "pd-balanced": "PDBalanced",
  "pd-extreme": "PDExtreme",
};

/** Hourly cost of a persistent disk = sizeGb × per-GiB-month ÷ 730. */
export function priceDisk(
  opts: { sizeGb: number; diskType: string; region: string },
  skus: Sku[],
): Money | undefined {
  const group = DISK_GROUP[opts.diskType];
  if (!group || !opts.sizeGb) return undefined;
  const sku = skus.find(
    (s) =>
      s.category?.resourceGroup === group &&
      s.category?.usageType === "OnDemand" &&
      (s.serviceRegions || []).includes(opts.region) &&
      (s.description || "").toLowerCase().includes("capacity"),
  );
  const price = sku ? skuUnitPrice(sku) : undefined;
  if (!price) return undefined;
  return { amount: (opts.sizeGb * price.amount) / HOURS_PER_MONTH, currency: price.currency };
}

/** Hours a resource has been live, from an RFC3339 creation time. */
export function hoursSince(creationTimestamp: string | undefined, now: number): number | undefined {
  if (!creationTimestamp) return undefined;
  const created = Date.parse(creationTimestamp);
  if (Number.isNaN(created)) return undefined;
  return Math.max(0, (now - created) / 3_600_000);
}

// --- SKU fetch + cache (I/O) ------------------------------------------------

let skuCache: { at: number; skus: Sku[] } | undefined;

export function _resetSkuCacheForTests() {
  skuCache = undefined;
}

/** Fetch (and cache) the Compute Engine SKU catalog. */
export async function fetchComputeSkus(credentialsFile: string): Promise<Sku[]> {
  if (skuCache && Date.now() - skuCache.at < SKU_TTL_MS) return skuCache.skus;
  const key = process.env.REW_GCP_API_KEY;
  const url =
    `https://cloudbilling.googleapis.com/v1/services/${COMPUTE_SERVICE}/skus?currencyCode=USD&pageSize=5000` +
    (key ? `&key=${encodeURIComponent(key)}` : "");
  const skus = await gcpGetAll<Sku>(credentialsFile, url, "skus");
  skuCache = { at: Date.now(), skus };
  return skus;
}

export interface PricingContext {
  skus: Sku[];
  now: number;
  /** Resolve a machine type's vCPU/RAM (cached by the caller). */
  machineType: (zone: string, type: string) => Promise<{ guestCpus: number; memoryMb: number } | undefined>;
}

/**
 * Fill costPerHour/costSoFar on each resource in place-ish (returns new
 * objects). Unknown rate ⇒ both left undefined. costSoFar = rate × uptime.
 */
export async function priceResources(
  resources: readonly LiveResource[],
  ctx: PricingContext,
): Promise<LiveResource[]> {
  return mapWithConcurrency(resources, 6, async (r) => {
    let rate: Money | undefined;
    if (r.kind === "compute.instance") {
      const zone = String(r.attrs.zone || r.location);
      const type = String(r.attrs.machineType || "");
      const mt = type ? await ctx.machineType(zone, type) : undefined;
      if (mt) {
        rate = priceInstance(
          { machineType: type, guestCpus: mt.guestCpus, memoryMb: mt.memoryMb, region: regionOf(r.location) },
          ctx.skus,
        );
      }
    } else if (r.kind === "compute.disk") {
      rate = priceDisk(
        { sizeGb: Number(r.attrs.sizeGb) || 0, diskType: String(r.attrs.diskType || ""), region: regionOf(r.location) },
        ctx.skus,
      );
    }

    if (!rate) return r;
    const hours = hoursSince(r.creationTimestamp, ctx.now);
    return {
      ...r,
      currency: rate.currency,
      costPerHour: rate.amount,
      costSoFar: hours === undefined ? undefined : rate.amount * hours,
    };
  });
}

/** A location may be a zone ("europe-west1-b") or already a region. */
function regionOf(location: string): string {
  return location.replace(/-[a-z]$/, "");
}
