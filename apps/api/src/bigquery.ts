import type { BigquerySpec } from "./types.js";

export const MAX_DATASETS = 8;
const MAX_DATASET_SLUG = 30;

/** Slugify + validate a dataset short name. BigQuery ids allow letters/digits/underscore. */
export function normalizeDatasetName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_DATASET_SLUG)
    .replace(/_+$/g, "");
  if (!slug) throw new Error("BigQuery dataset name is required");
  if (!/^[a-z]/.test(slug)) throw new Error("BigQuery dataset names must start with a letter");
  return slug;
}

/** Dataset id: `<deploymentPrefix>_<slug>`, with the prefix's hyphens converted to underscores. */
export function datasetFullId(deploymentPrefix: string, name: string): string {
  return `${deploymentPrefix.replace(/-/g, "_")}_${name}`;
}

/** Validate + clamp the BigQuery datasets for a deployment. Pure (no I/O). */
export function normalizeBigquery(input: { bigquery_datasets?: BigquerySpec[] }): Required<BigquerySpec>[] {
  const listed = input.bigquery_datasets || [];
  if (listed.length > MAX_DATASETS) {
    throw new Error(`A deployment can have at most ${MAX_DATASETS} BigQuery datasets`);
  }
  const seen = new Set<string>();
  return listed.map((d) => {
    const name = normalizeDatasetName(d.name);
    if (seen.has(name)) throw new Error(`BigQuery dataset names must be unique (${name})`);
    seen.add(name);
    return {
      name,
      location: String(d.location ?? "").trim(),
      access: d.access === "read" ? "read" : "readwrite",
    };
  });
}

/** Dataset-level IAM role granted to a connected consumer's SA. */
export function datasetGrantRole(access: "read" | "readwrite"): string {
  return access === "read" ? "roles/bigquery.dataViewer" : "roles/bigquery.dataEditor";
}
