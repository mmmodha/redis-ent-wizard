import { gcpPost } from "./gcp.js";

/**
 * Optional real cost-so-far from a Cloud Billing → BigQuery export.
 *
 * GCP does not create this export automatically. When an operator has set one
 * up and points `REW_BILLING_EXPORT_TABLE` at it (a *detailed* usage export,
 * `<project>.<dataset>.gcp_billing_export_resource_v1_XXXXXX`, which carries
 * `resource.name`), we sum actual billed cost per resource and use it in place
 * of the rate × uptime estimate. Absent or on any error, the estimate stands.
 */

export function billingTable(): string | undefined {
  return process.env.REW_BILLING_EXPORT_TABLE?.trim() || undefined;
}

export interface BillingByResource {
  /** resource short-name → actual cost summed over its lifetime. */
  byName: Map<string, number>;
  currency?: string;
}

interface QueryResponse {
  jobComplete?: boolean;
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  errors?: Array<{ message?: string }>;
}

/** Pure: turn a BigQuery jobs.query response into a name→cost map. */
export function parseBillingRows(resp: QueryResponse): BillingByResource {
  const fields = resp.schema?.fields || [];
  const idx = (n: string) => fields.findIndex((f) => f.name === n);
  const nameI = idx("name");
  const costI = idx("cost");
  const curI = idx("currency");
  const byName = new Map<string, number>();
  let currency: string | undefined;
  if (nameI < 0 || costI < 0) return { byName, currency };
  for (const row of resp.rows || []) {
    const cells = row.f || [];
    const rawName = cells[nameI]?.v;
    if (typeof rawName !== "string" || !rawName) continue;
    // resource.name is often a full path; key by the last segment to match our
    // short resource names.
    const name = rawName.split("/").pop() || rawName;
    const cost = Number(cells[costI]?.v) || 0;
    byName.set(name, (byName.get(name) || 0) + cost);
    if (curI >= 0 && !currency) {
      const c = cells[curI]?.v;
      if (typeof c === "string") currency = c;
    }
  }
  return { byName, currency };
}

/** Run the grouped-cost query against the configured export table. */
export async function fetchBillingByResource(
  credentialsFile: string,
  project: string,
): Promise<BillingByResource> {
  const table = billingTable();
  if (!table) return { byName: new Map() };
  const billingProject = table.split(".")[0];
  const sql =
    `SELECT SPLIT(resource.name, '/')[SAFE_OFFSET(ARRAY_LENGTH(SPLIT(resource.name,'/'))-1)] AS name,` +
    ` SUM(cost) AS cost, ANY_VALUE(currency) AS currency` +
    ` FROM \`${table}\`` +
    ` WHERE project.id = @project AND resource.name IS NOT NULL` +
    ` GROUP BY name`;
  const resp = await gcpPost<QueryResponse>(
    credentialsFile,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(billingProject)}/queries`,
    {
      query: sql,
      useLegacySql: false,
      timeoutMs: 10_000,
      parameterMode: "NAMED",
      queryParameters: [
        { name: "project", parameterType: { type: "STRING" }, parameterValue: { value: project } },
      ],
    },
  );
  if (!resp.jobComplete) {
    throw new Error("billing query did not complete within the timeout");
  }
  return parseBillingRows(resp);
}
