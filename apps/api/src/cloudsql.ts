import type { CloudSqlSpec } from "./types.js";

export const MAX_SQL_INSTANCES = 8;
const MAX_SQL_SLUG = 30;

/** Slugify + validate an instance short name. The deployment prefix is added later. */
export function normalizeSqlName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SQL_SLUG)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("Cloud SQL instance name is required");
  if (!/^[a-z]/.test(slug)) throw new Error("Cloud SQL instance names must start with a letter");
  return slug;
}

/** The instance name within the project: `<deploymentPrefix>-<slug>`. */
export function sqlInstanceFullName(deploymentPrefix: string, name: string): string {
  return `${deploymentPrefix}-${name}`;
}

export function sqlDatabaseVersion(engine: "postgres" | "mysql"): string {
  return engine === "mysql" ? "MYSQL_8_0" : "POSTGRES_15";
}

export function sqlPort(engine: "postgres" | "mysql"): number {
  return engine === "mysql" ? 3306 : 5432;
}

/** Validate + clamp the Cloud SQL instances for a deployment. Pure (no I/O). */
export function normalizeCloudSql(input: { cloud_sql_instances?: CloudSqlSpec[] }): Required<CloudSqlSpec>[] {
  const listed = input.cloud_sql_instances || [];
  if (listed.length > MAX_SQL_INSTANCES) {
    throw new Error(`A deployment can have at most ${MAX_SQL_INSTANCES} Cloud SQL instances`);
  }
  const seen = new Set<string>();
  return listed.map((s) => {
    const name = normalizeSqlName(s.name);
    if (seen.has(name)) throw new Error(`Cloud SQL instance names must be unique (${name})`);
    seen.add(name);
    const engine = s.engine === "mysql" ? "mysql" : "postgres";
    return {
      name,
      engine,
      tier: String(s.tier ?? "").trim() || "db-f1-micro",
      db_name: String(s.db_name ?? "").trim() || "appdb",
      db_user: String(s.db_user ?? "").trim() || "appuser",
      connectivity:
        s.connectivity === "proxy" || s.connectivity === "public" ? s.connectivity : "private",
      cdc_enabled: Boolean(s.cdc_enabled),
    };
  });
}
