import type { StorageBucketSpec } from "./types.js";

export const MAX_BUCKETS = 8;
const MAX_BUCKET_SLUG = 20;
const STORAGE_CLASSES = ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"] as const;

/** Slugify + validate a bucket short name. The deployment prefix is added later. */
export function normalizeBucketName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BUCKET_SLUG)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("Storage bucket name is required");
  if (!/^[a-z]/.test(slug)) throw new Error("Storage bucket names must start with a letter");
  // GCS forbids names containing "google" or starting with the "goog" prefix.
  if (slug.startsWith("goog") || slug.includes("google")) {
    throw new Error(`Storage bucket name "${slug}" cannot contain "google" or start with "goog"`);
  }
  return slug;
}

/** The globally-unique bucket name: `<deploymentPrefix>-<slug>`. */
export function bucketFullName(deploymentPrefix: string, name: string): string {
  return `${deploymentPrefix}-${name}`;
}

/** Validate + clamp the storage buckets for a deployment. Pure (no I/O). */
export function normalizeStorageBuckets(input: {
  storage_buckets?: StorageBucketSpec[];
}): Required<StorageBucketSpec>[] {
  const listed = input.storage_buckets || [];
  if (listed.length > MAX_BUCKETS) {
    throw new Error(`A deployment can have at most ${MAX_BUCKETS} storage buckets`);
  }
  const seen = new Set<string>();
  return listed.map((b) => {
    const name = normalizeBucketName(b.name);
    if (seen.has(name)) throw new Error(`Storage bucket names must be unique (${name})`);
    seen.add(name);
    return {
      name,
      location: String(b.location ?? "").trim(),
      storage_class: STORAGE_CLASSES.includes(b.storage_class as (typeof STORAGE_CLASSES)[number])
        ? (b.storage_class as (typeof STORAGE_CLASSES)[number])
        : "STANDARD",
      versioning: Boolean(b.versioning),
      force_destroy: b.force_destroy === undefined ? true : Boolean(b.force_destroy),
      access: b.access === "read" ? "read" : "readwrite",
    };
  });
}

/** IAM role granted to a connected consumer's service account for the given access level. */
export function bucketGrantRole(access: "read" | "readwrite"): string {
  return access === "read" ? "roles/storage.objectViewer" : "roles/storage.objectAdmin";
}
