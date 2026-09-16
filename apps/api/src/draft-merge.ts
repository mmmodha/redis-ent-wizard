/**
 * Deep-patch merge for collaborative draft editing (the MCP `update_design`
 * surface). An AI tool sends a partial config; it is merged onto the existing
 * draft so a human and Claude can work on the same draft in tandem:
 *
 * - Objects merge recursively — keys present in the patch win, keys the patch
 *   omits are kept from the existing draft.
 * - Arrays of *named* items (clusters, databases, applications, …) merge by
 *   their identity key; an item the patch names is merged into the existing one,
 *   a new name is appended, and items the patch doesn't mention are kept. Plain
 *   value arrays (region_zones, ports, …) are replaced when the patch sets them.
 * - **Human-owned fields are protected**: a per-cluster license, per-database
 *   password (incl. the RDI target DB), and per-cluster admin username that the
 *   human already set are never overwritten by a patch.
 *
 * Pure and network-free.
 */

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v !== undefined && v !== null;
}

// Array property name -> the field that identifies an item within it. Any array
// not listed here is treated as a value array and replaced wholesale by a patch.
const ARRAY_MATCH_KEY: Record<string, string> = {
  clusters: "name",
  databases: "name",
  applications: "name",
  load_balancers: "name",
  cloud_sql_instances: "name",
  pubsub_topics: "name",
  bigquery_datasets: "name",
  storage_buckets: "name",
  pipelines: "source",
  tables: "table",
};

function mergeNamedArray(existing: unknown[], patch: unknown[], key: string): unknown[] {
  const out: unknown[] = existing.map((e) => (isPlainObject(e) ? { ...e } : e));
  for (const pItem of patch) {
    if (!isPlainObject(pItem)) {
      out.push(pItem);
      continue;
    }
    const idx = out.findIndex((e) => isPlainObject(e) && e[key] === pItem[key]);
    if (idx >= 0) out[idx] = deepMerge(out[idx] as Obj, pItem);
    else out.push(pItem);
  }
  return out;
}

function deepMerge(existing: Obj, patch: Obj): Obj {
  const out: Obj = { ...existing };
  for (const [k, pv] of Object.entries(patch)) {
    const ev = out[k];
    if (Array.isArray(pv) && ARRAY_MATCH_KEY[k] && Array.isArray(ev)) {
      out[k] = mergeNamedArray(ev, pv, ARRAY_MATCH_KEY[k]);
    } else if (isPlainObject(pv) && isPlainObject(ev)) {
      out[k] = deepMerge(ev, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** Re-apply human-owned fields from the existing draft over the merged result. */
function protectHumanFields(existing: Obj, merged: Obj): void {
  const exClusters = Array.isArray(existing.clusters) ? (existing.clusters as Obj[]) : [];
  const mgClusters = Array.isArray(merged.clusters) ? (merged.clusters as Obj[]) : [];
  for (const mc of mgClusters) {
    const ec = exClusters.find((c) => isPlainObject(c) && c.name === mc.name);
    if (!ec) continue;
    if (nonEmpty(ec.license)) mc.license = ec.license;
    if (nonEmpty(ec.RS_admin)) mc.RS_admin = ec.RS_admin;
    const exDbs = Array.isArray(ec.databases) ? (ec.databases as Obj[]) : [];
    const mgDbs = Array.isArray(mc.databases) ? (mc.databases as Obj[]) : [];
    for (const md of mgDbs) {
      const ed = exDbs.find((d) => isPlainObject(d) && d.name === md.name);
      if (ed && nonEmpty(ed.password)) md.password = ed.password;
    }
  }
}

/**
 * Merge `patch` onto `existing` (both create-configs) for a draft update.
 * Keeps the id-defining fields (name/env) from the existing draft so a patch
 * can't silently rename the draft.
 */
export function mergeDraftConfig(existing: Obj, patch: Obj): Obj {
  const merged = deepMerge(existing, patch);
  protectHumanFields(existing, merged);
  if (typeof existing.name === "string") merged.name = existing.name;
  merged.env = existing.env; // preserve id stability (may be undefined = "default")
  return merged;
}
