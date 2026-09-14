"use client";

import { useState } from "react";
import { MachineTypePicker } from "@/components/MachineTypePicker";
import { uploadArtifact, type MachineTypeInfo } from "@/lib/api";
import {
  APP_REQUIREMENTS,
  ARTIFACT_SOURCE_OPTIONS,
  DB_MODULES,
  EVICTION_POLICIES,
  withGitSourceRequirements,
  type ArtifactSource,
} from "@/lib/diagram";
import { canEnableDbReplication, dbReplicationHint } from "@/lib/db-replication";
import { clusterTrialShardGate } from "@/lib/trial-shards";

type Mode = "vm" | "gke";

const APP_DISK_OPTIONS = [0, 50, 100, 200, 500, 1000];

/** A database draft matching the backend `databaseSchema` shape exactly. */
export type DatabaseDraft = {
  name: string;
  memory_gb: number;
  replication: boolean;
  sharding: boolean;
  shards_count: number;
  eviction_policy: string;
  port: number;
  password: string;
  modules: string[];
  proxy_policy: "single" | "all-master-shards";
  shards_placement: "dense" | "sparse";
  oss_cluster: boolean;
  flex: boolean;
};

/** An application draft matching the backend `applicationSchema` shape. */
export type ApplicationDraft = {
  name: string;
  command: string;
  ports: string;
  env: { key: string; value: string }[];
  connectClusters: string[];
  connectDatabases: string[];
  connectLoadBalancers: string[];
  connectApps: string[];
  connectStorage: string[];
  connectPubsub: string[];
  connectBigquery: string[];
  connectSql: string[];
  requirements: string[];
  // VM mode
  artifact: ArtifactSource;
  vm_count: number;
  machine_type: string;
  disk_gib: number;
  // GKE mode
  image: string;
  replicas: number;
  expose: "none" | "lb";
};

/** A load balancer draft (VM mode only). */
export type LbDraft = {
  name: string;
  target: string;
  target_kind: "application" | "vms";
  ports: string;
};

/** A Cloud Storage bucket draft. */
export type StorageDraft = {
  name: string;
  location: string;
  storage_class: "STANDARD" | "NEARLINE" | "COLDLINE" | "ARCHIVE";
  versioning: boolean;
  force_destroy: boolean;
  access: "read" | "readwrite";
};

export function blankStorage(): StorageDraft {
  return {
    name: "",
    location: "",
    storage_class: "STANDARD",
    versioning: false,
    force_destroy: true,
    access: "readwrite",
  };
}

/** A BigQuery dataset draft. */
export type BigqueryDraft = {
  name: string;
  location: string;
  access: "read" | "readwrite";
};

export function blankBigquery(): BigqueryDraft {
  return { name: "", location: "", access: "readwrite" };
}

export function bigqueryDraftFromConfig(d: Record<string, unknown>): BigqueryDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: s(d.name),
    location: s(d.location),
    access: d.access === "read" ? "read" : "readwrite",
  };
}

/** A Cloud SQL instance draft. */
export type CloudSqlDraft = {
  name: string;
  engine: "postgres" | "mysql";
  tier: string;
  db_name: string;
  db_user: string;
  connectivity: "private" | "proxy" | "public";
};

export function blankCloudSql(): CloudSqlDraft {
  return {
    name: "",
    engine: "postgres",
    tier: "db-f1-micro",
    db_name: "appdb",
    db_user: "appuser",
    connectivity: "private",
  };
}

export function cloudsqlDraftFromConfig(d: Record<string, unknown>): CloudSqlDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const conn = s(d.connectivity);
  return {
    name: s(d.name),
    engine: d.engine === "mysql" ? "mysql" : "postgres",
    tier: s(d.tier) || "db-f1-micro",
    db_name: s(d.db_name) || "appdb",
    db_user: s(d.db_user) || "appuser",
    connectivity: (["private", "proxy", "public"].includes(conn) ? conn : "private") as CloudSqlDraft["connectivity"],
  };
}

/** RDI pipeline table mapping draft. */
export type RdiTableDraft = { table: string; key_prefix: string };
/** One RDI pipeline draft (a Cloud SQL source + its table mappings). */
export type RdiPipelineDraft = { source: string; tables: RdiTableDraft[] };
/** Redis Data Integration draft (one per deployment). */
export type RdiDraft = {
  name: string;
  machine_type: string;
  target: string;
  pipelines: RdiPipelineDraft[];
};

export function blankRdi(): RdiDraft {
  return { name: "", machine_type: "n2-standard-4", target: "", pipelines: [] };
}

export function rdiDraftFromConfig(r: Record<string, unknown>): RdiDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const pipelines = Array.isArray(r.pipelines)
    ? (r.pipelines as Record<string, unknown>[]).map((p) => ({
        source: s(p.source),
        tables: Array.isArray(p.tables)
          ? (p.tables as Record<string, unknown>[]).map((t) => ({
              table: s(t.table),
              key_prefix: s(t.key_prefix),
            }))
          : [],
      }))
    : [];
  return {
    name: s(r.name),
    machine_type: s(r.machine_type) || "n2-standard-4",
    target: s(r.target),
    pipelines,
  };
}

/** A Pub/Sub topic draft. */
export type PubsubDraft = {
  name: string;
  create_subscription: boolean;
  role: "publish" | "subscribe" | "both";
};

export function blankPubsub(): PubsubDraft {
  return { name: "", create_subscription: true, role: "both" };
}

export function pubsubDraftFromConfig(t: Record<string, unknown>): PubsubDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const role = s(t.role);
  return {
    name: s(t.name),
    create_subscription: t.create_subscription === undefined ? true : Boolean(t.create_subscription),
    role: role === "publish" || role === "subscribe" ? role : "both",
  };
}

export function storageDraftFromConfig(b: Record<string, unknown>): StorageDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const cls = s(b.storage_class);
  return {
    name: s(b.name),
    location: s(b.location),
    storage_class: (["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"].includes(cls)
      ? cls
      : "STANDARD") as StorageDraft["storage_class"],
    versioning: Boolean(b.versioning),
    force_destroy: b.force_destroy === undefined ? true : Boolean(b.force_destroy),
    access: b.access === "read" ? "read" : "readwrite",
  };
}

export function blankDatabase(clusterNodes = 3): DatabaseDraft {
  return {
    name: "",
    memory_gb: 1,
    replication: canEnableDbReplication(clusterNodes),
    sharding: false,
    shards_count: 2,
    eviction_policy: "noeviction",
    port: 12000,
    password: "",
    modules: [],
    proxy_policy: "single",
    shards_placement: "dense",
    oss_cluster: false,
    flex: false,
  };
}

export function blankApplication(machineType = ""): ApplicationDraft {
  return {
    name: "",
    command: "",
    ports: "",
    env: [],
    connectClusters: [],
    connectDatabases: [],
    connectLoadBalancers: [],
    connectApps: [],
    connectStorage: [],
    connectPubsub: [],
    connectBigquery: [],
    connectSql: [],
    requirements: [],
    artifact: { kind: "upload", ref: "", type: "jar" },
    vm_count: 1,
    machine_type: machineType,
    disk_gib: 0,
    image: "",
    replicas: 1,
    expose: "none",
  };
}

export function blankLb(): LbDraft {
  return { name: "", target: "app", target_kind: "vms", ports: "" };
}

function inferType(filename: string): "jar" | "binary" {
  return filename.toLowerCase().endsWith(".jar") ? "jar" : "binary";
}

/** Rebuild a database draft from a stored create-config entry. */
export function databaseDraftFromConfig(d: Record<string, unknown>): DatabaseDraft {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: s(d.name) || "db",
    memory_gb: num(d.memory_gb, 1),
    replication: d.replication === undefined ? true : Boolean(d.replication),
    sharding: Boolean(d.sharding),
    shards_count: num(d.shards_count, 2),
    eviction_policy: s(d.eviction_policy) || "noeviction",
    port: num(d.port, 12000),
    password: s(d.password),
    modules: Array.isArray(d.modules) ? (d.modules as unknown[]).map(String) : [],
    proxy_policy: d.proxy_policy === "all-master-shards" ? "all-master-shards" : "single",
    shards_placement: d.shards_placement === "sparse" ? "sparse" : "dense",
    oss_cluster: Boolean(d.oss_cluster),
    flex: Boolean(d.flex),
  };
}

/** A checkbox multi-select of connectable provider names. */
function ConnectPicker({
  label,
  hint,
  options,
  selected,
  onToggle,
}: {
  label: string;
  hint: string;
  options: string[];
  selected: string[];
  onToggle: (name: string, on: boolean) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="wiz-field-wide">
      <span className="machine-picker-label">{label}</span>
      <div className="wiz-badges">
        {options.map((cn) => (
          <label key={cn} className="wiz-check-row">
            <input
              type="checkbox"
              checked={selected.includes(cn)}
              onChange={(e) => onToggle(cn, e.target.checked)}
            />
            {cn}
          </label>
        ))}
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}

/** Connections from the Set-of-VMs group to providers (emits vms_connect). */
export function VmsConnectEditor({
  value,
  onChange,
  clusterNames,
  databaseNames,
  loadBalancerNames,
  appHostNames,
  storageNames,
  pubsubNames,
  bigqueryNames,
  cloudsqlNames,
}: {
  value: {
    clusters: string[];
    databases: string[];
    load_balancers: string[];
    apps: string[];
    storage: string[];
    pubsub: string[];
    bigquery: string[];
    sql: string[];
  };
  onChange: (v: {
    clusters: string[];
    databases: string[];
    load_balancers: string[];
    apps: string[];
    storage: string[];
    pubsub: string[];
    bigquery: string[];
    sql: string[];
  }) => void;
  clusterNames: string[];
  databaseNames: string[];
  loadBalancerNames: string[];
  appHostNames: string[];
  storageNames: string[];
  pubsubNames: string[];
  bigqueryNames: string[];
  cloudsqlNames: string[];
}) {
  const toggle = (field: keyof typeof value, name: string, on: boolean) =>
    onChange({ ...value, [field]: on ? [...value[field], name] : value[field].filter((x) => x !== name) });
  if (
    !clusterNames.length &&
    !databaseNames.length &&
    !loadBalancerNames.length &&
    !appHostNames.length &&
    !storageNames.length &&
    !pubsubNames.length &&
    !bigqueryNames.length &&
    !cloudsqlNames.length
  ) {
    return null;
  }
  return (
    <div className="companion-block">
      <h3 className="companion-title">Set-of-VMs connections (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Injects endpoints and credentials into every app VM (readable at /opt/rew/connections.env).
      </p>
      <ConnectPicker
        label="Connect to clusters"
        hint="Injects REDIS_<CLUSTER>_HOST and admin credentials."
        options={clusterNames}
        selected={value.clusters}
        onToggle={(n, on) => toggle("clusters", n, on)}
      />
      <ConnectPicker
        label="Connect to databases"
        hint="Injects REDIS_<DB>_ENDPOINT."
        options={databaseNames}
        selected={value.databases}
        onToggle={(n, on) => toggle("databases", n, on)}
      />
      <ConnectPicker
        label="Connect to load balancers"
        hint="Injects LB_<LB>_ENDPOINT (its VIP)."
        options={loadBalancerNames}
        selected={value.load_balancers}
        onToggle={(n, on) => toggle("load_balancers", n, on)}
      />
      <ConnectPicker
        label="Connect to apps"
        hint="Injects <NAME>_HOST (the target's hostname)."
        options={appHostNames.filter((n) => n !== "app")}
        selected={value.apps}
        onToggle={(n, on) => toggle("apps", n, on)}
      />
      <ConnectPicker
        label="Connect to storage"
        hint="Injects GCS_<BUCKET>_BUCKET / _URL and grants bucket access."
        options={storageNames}
        selected={value.storage}
        onToggle={(n, on) => toggle("storage", n, on)}
      />
      <ConnectPicker
        label="Connect to Pub/Sub"
        hint="Injects PUBSUB_<TOPIC>_TOPIC / _SUBSCRIPTION and grants publish/subscribe."
        options={pubsubNames}
        selected={value.pubsub}
        onToggle={(n, on) => toggle("pubsub", n, on)}
      />
      <ConnectPicker
        label="Connect to BigQuery"
        hint="Injects BIGQUERY_<DATASET>_DATASET and grants dataset + jobUser access."
        options={bigqueryNames}
        selected={value.bigquery}
        onToggle={(n, on) => toggle("bigquery", n, on)}
      />
      <ConnectPicker
        label="Connect to Cloud SQL"
        hint="Injects SQL_<NAME>_HOST / _CONNECTION_NAME / _DB / _USER / _PASSWORD and grants the Cloud SQL client role."
        options={cloudsqlNames}
        selected={value.sql}
        onToggle={(n, on) => toggle("sql", n, on)}
      />
    </div>
  );
}

/** Per-cluster databases editor, shown inside each cluster card. */
export function DatabaseEditor({
  databases,
  onChange,
  clusterHasNvme,
  clusterNodes,
  license,
}: {
  databases: DatabaseDraft[];
  onChange: (dbs: DatabaseDraft[]) => void;
  clusterHasNvme: boolean;
  clusterNodes: number;
  license?: string;
}) {
  const allowReplication = canEnableDbReplication(clusterNodes);
  const replicationHint = dbReplicationHint(clusterNodes);
  const trial = clusterTrialShardGate({ license, databases, nodes: clusterNodes });
  const patch = (i: number, p: Partial<DatabaseDraft>) =>
    onChange(databases.map((d, idx) => (idx === i ? { ...d, ...p } : d)));

  return (
    <div className="wiz-field-wide">
      <span className="machine-picker-label">Databases</span>
      {trial.blocked ? <div className="notice notice-warn">{trial.message}</div> : null}
      {databases.map((db, i) => (
        <div className="wiz-workload-card" key={`db-${i}`}>
          <div className="wiz-workload-head">
            <h4>{db.name.trim() || `Database ${i + 1}`}</h4>
            <button
              type="button"
              className="btn"
              onClick={() => onChange(databases.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Database name
              <input
                value={db.name}
                onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })}
                placeholder="cache-db"
              />
            </label>
            <label>
              Memory (GB)
              <input
                type="number"
                min={1}
                value={db.memory_gb}
                onChange={(e) => patch(i, { memory_gb: Number(e.target.value) })}
              />
            </label>
            <label
              className="wiz-check-row"
              title={allowReplication ? undefined : replicationHint}
            >
              <input
                type="checkbox"
                disabled={!allowReplication}
                checked={allowReplication && db.replication}
                onChange={(e) => patch(i, { replication: e.target.checked })}
              />
              Replication (HA){allowReplication ? "" : " · needs 2+ nodes"}
            </label>
            <label className="wiz-check-row">
              <input
                type="checkbox"
                checked={db.sharding}
                onChange={(e) => patch(i, { sharding: e.target.checked })}
              />
              Sharding
            </label>
            {db.sharding ? (
              <label>
                Shards
                <input
                  type="number"
                  min={2}
                  max={100}
                  value={db.shards_count}
                  onChange={(e) => patch(i, { shards_count: Number(e.target.value) })}
                />
              </label>
            ) : (
              <div />
            )}
            <label
              className="wiz-check-row"
              title={clusterHasNvme ? undefined : "Add NVMe disks to the Redis cluster to enable Redis on Flash"}
            >
              <input
                type="checkbox"
                disabled={!clusterHasNvme}
                checked={clusterHasNvme && db.flex}
                onChange={(e) => patch(i, { flex: e.target.checked })}
              />
              Flex (Redis on Flash){clusterHasNvme ? "" : " · needs NVMe on the cluster"}
            </label>
            <label className="wiz-check-row">
              <input
                type="checkbox"
                checked={db.oss_cluster}
                onChange={(e) =>
                  patch(
                    i,
                    e.target.checked
                      ? { oss_cluster: true, proxy_policy: "all-master-shards" }
                      : { oss_cluster: false },
                  )
                }
              />
              OSS Cluster API
            </label>
            <label>
              Proxy policy
              <select
                value={db.proxy_policy}
                disabled={db.oss_cluster}
                onChange={(e) =>
                  patch(i, { proxy_policy: e.target.value as DatabaseDraft["proxy_policy"] })
                }
              >
                <option value="single">Single proxy (one endpoint)</option>
                <option value="all-master-shards">All primary nodes</option>
              </select>
            </label>
            <label>
              Shards placement
              <select
                value={db.shards_placement}
                onChange={(e) =>
                  patch(i, { shards_placement: e.target.value as DatabaseDraft["shards_placement"] })
                }
              >
                <option value="dense">Dense (pack onto fewer nodes)</option>
                <option value="sparse">Sparse (spread across nodes)</option>
              </select>
            </label>
            <label>
              Eviction policy
              <select
                value={db.eviction_policy}
                onChange={(e) => patch(i, { eviction_policy: e.target.value })}
              >
                {EVICTION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Port
              <input
                type="number"
                value={db.port}
                onChange={(e) => patch(i, { port: Number(e.target.value) })}
              />
            </label>
            <label>
              Password
              <input
                type="text"
                value={db.password}
                onChange={(e) => patch(i, { password: e.target.value })}
                placeholder="optional"
              />
            </label>
          </div>
          <div className="wiz-field-wide">
            <span className="machine-picker-label">Modules</span>
            <div className="wiz-badges">
              {DB_MODULES.map((m) => {
                const on = db.modules.includes(m.id);
                return (
                  <label key={m.id} className="wiz-check-row">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        patch(i, {
                          modules: e.target.checked
                            ? [...db.modules, m.id]
                            : db.modules.filter((x) => x !== m.id),
                        })
                      }
                    />
                    {m.label}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      ))}
      <div>
        <button type="button" className="btn" onClick={() => onChange([...databases, blankDatabase(clusterNodes)])}>
          Add database
        </button>
      </div>
      <span className="hint">Optional. Databases are created on this cluster after it is up.</span>
    </div>
  );
}

/** Applications editor (VM or GKE fields depending on mode). */
export function ApplicationsEditor({
  applications,
  onChange,
  mode,
  machineTypes,
  loadingMachines,
  probeZone,
  defaultMachineType,
  clusterNames,
  databaseNames = [],
  loadBalancerNames = [],
  appHostNames = [],
  storageNames = [],
  pubsubNames = [],
  bigqueryNames = [],
  cloudsqlNames = [],
}: {
  applications: ApplicationDraft[];
  onChange: (apps: ApplicationDraft[]) => void;
  mode: Mode;
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
  defaultMachineType: string;
  clusterNames: string[];
  databaseNames?: string[];
  loadBalancerNames?: string[];
  appHostNames?: string[];
  storageNames?: string[];
  pubsubNames?: string[];
  bigqueryNames?: string[];
  cloudsqlNames?: string[];
}) {
  const [uploading, setUploading] = useState<Record<number, boolean>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<number, string>>({});

  const patch = (i: number, p: Partial<ApplicationDraft>) =>
    onChange(applications.map((a, idx) => (idx === i ? { ...a, ...p } : a)));

  async function upload(i: number, file: File, current: ArtifactSource) {
    setUploadErrors((e) => ({ ...e, [i]: "" }));
    setUploading((u) => ({ ...u, [i]: true }));
    try {
      const artifact = await uploadArtifact(file);
      patch(i, { artifact: { kind: "upload", ref: artifact.id, type: artifact.type } });
    } catch (err) {
      setUploadErrors((e) => ({ ...e, [i]: err instanceof Error ? err.message : "Upload failed" }));
      patch(i, { artifact: { ...current, type: inferType(file.name) } });
    } finally {
      setUploading((u) => ({ ...u, [i]: false }));
    }
  }

  return (
    <div className="companion-block">
      <h3 className="companion-title">Applications (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        {mode === "vm"
          ? "Stage or run your own workloads on dedicated VMs and connect them to a cluster."
          : "Deploy your own container workloads into the GKE cluster alongside Redis."}
      </p>

      {applications.map((app, i) => (
        <div className="wiz-workload-card" key={`app-${i}`}>
          <div className="wiz-workload-head">
            <h4>{app.name.trim() || `Application ${i + 1}`}</h4>
            <button
              type="button"
              className="btn"
              onClick={() => onChange(applications.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>

          <div className="grid grid-2">
            <label>
              Name
              <input
                value={app.name}
                onChange={(e) => patch(i, { name: e.target.value.slice(0, 24) })}
                placeholder="loadgen"
              />
            </label>
            <label>
              Ports
              <input
                value={app.ports}
                onChange={(e) => patch(i, { ports: e.target.value })}
                placeholder="8080, 9090"
              />
              <span className="hint">Comma-separated ports exposed by the app.</span>
            </label>

            {mode === "vm" ? (
              <>
                <div className="wiz-field-wide">
                  <span className="machine-picker-label">Artifact source</span>
                  <div className="wiz-radio-row">
                    {ARTIFACT_SOURCE_OPTIONS.map((opt) => (
                      <label key={opt.kind} className="wiz-check-row">
                        <input
                          type="radio"
                          name={`artifact-kind-${i}`}
                          checked={app.artifact.kind === opt.kind}
                          onChange={() =>
                            patch(i, {
                              artifact: {
                                ...app.artifact,
                                kind: opt.kind,
                                runInDocker: opt.kind === "git" ? Boolean(app.artifact.runInDocker) : false,
                              },
                              requirements:
                                opt.kind === "git"
                                  ? withGitSourceRequirements(app.requirements, Boolean(app.artifact.runInDocker))
                                  : app.requirements,
                            })
                          }
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>

                {app.artifact.kind === "upload" ? (
                  <div className="wiz-field-wide">
                    <label>
                      Upload artifact
                      <input
                        type="file"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void upload(i, file, app.artifact);
                        }}
                      />
                    </label>
                    {uploading[i] ? <span className="hint">Uploading…</span> : null}
                    {uploadErrors[i] ? <span className="field-error">{uploadErrors[i]}</span> : null}
                    {app.artifact.ref ? (
                      <span className="hint mono">stored: {app.artifact.ref}</span>
                    ) : null}
                  </div>
                ) : app.artifact.kind === "git" ? (
                  <>
                    <label className="wiz-field-wide">
                      GitHub URL
                      <input
                        value={app.artifact.ref}
                        onChange={(e) =>
                          patch(i, {
                            artifact: { ...app.artifact, ref: e.target.value, type: "binary" },
                          })
                        }
                        placeholder="https://github.com/org/repo"
                      />
                    </label>
                    <label>
                      Branch or tag
                      <input
                        value={app.artifact.branch || ""}
                        onChange={(e) =>
                          patch(i, { artifact: { ...app.artifact, branch: e.target.value } })
                        }
                        placeholder="default branch"
                      />
                    </label>
                    <label className="wiz-check-row wiz-field-wide">
                      <input
                        type="checkbox"
                        checked={Boolean(app.artifact.runInDocker)}
                        onChange={(e) =>
                          patch(i, {
                            artifact: { ...app.artifact, runInDocker: e.target.checked },
                            requirements: withGitSourceRequirements(app.requirements, e.target.checked),
                          })
                        }
                      />
                      Run with Docker
                    </label>
                    <p className="hint wiz-field-wide">
                      The VM clones this repo into /opt/app and installs git.
                      {app.artifact.runInDocker
                        ? " Docker is installed so you can run Compose or docker run."
                        : " Turn on Docker only if the app should run in a container."}
                    </p>
                  </>
                ) : (
                  <label className="wiz-field-wide">
                    {app.artifact.kind === "url" ? "Artifact URL" : "GCS path"}
                    <input
                      value={app.artifact.ref}
                      onChange={(e) =>
                        patch(i, {
                          artifact: {
                            ...app.artifact,
                            ref: e.target.value,
                            type: inferType(e.target.value),
                          },
                        })
                      }
                      placeholder={app.artifact.kind === "url" ? "https://…/app.jar" : "gs://bucket/app.jar"}
                    />
                  </label>
                )}

                {app.artifact.kind === "git" ? null : (
                <label>
                  Artifact type
                  <select
                    value={app.artifact.type}
                    onChange={(e) =>
                      patch(i, {
                        artifact: { ...app.artifact, type: e.target.value as "jar" | "binary" },
                      })
                    }
                  >
                    <option value="jar">jar</option>
                    <option value="binary">binary</option>
                  </select>
                </label>
                )}

                <label className="wiz-field-wide">
                  Command
                  <input
                    value={app.command}
                    onChange={(e) => patch(i, { command: e.target.value })}
                    placeholder={
                      app.artifact.kind === "git" && app.artifact.runInDocker
                        ? "HTTP_PORT=8080 docker compose up --build"
                        : "empty = stage only"
                    }
                  />
                  <span className="hint">
                    {app.artifact.kind === "git"
                      ? "Runs from the cloned repo in /opt/app. Leave empty to clone without starting."
                      : "Leave empty to stage the artifact without starting it."}
                  </span>
                </label>

                <label>
                  VM count
                  <select
                    value={app.vm_count}
                    onChange={(e) => patch(i, { vm_count: Number(e.target.value) })}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n} VM{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </label>

                <MachineTypePicker
                  label="Machine type"
                  value={app.machine_type}
                  onChange={(v) => patch(i, { machine_type: v })}
                  machineTypes={machineTypes}
                  loading={loadingMachines}
                  preferredFamilies={["n2", "e2", "n2d"]}
                  hint={`Types available in ${probeZone || "selected zone"}`}
                />

                <label>
                  Disk (GiB)
                  <select
                    value={app.disk_gib}
                    onChange={(e) => patch(i, { disk_gib: Number(e.target.value) })}
                  >
                    {APP_DISK_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? "None — boot disk only" : `${n} GiB at /data`}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="wiz-field-wide">
                  <span className="machine-picker-label">Requirements to install</span>
                  <div className="wiz-badges">
                    {APP_REQUIREMENTS.map((r) => {
                      const requiredGit = app.artifact.kind === "git" && r.id === "git";
                      const requiredDocker =
                        app.artifact.kind === "git" && app.artifact.runInDocker && r.id === "docker";
                      const locked = requiredGit || requiredDocker;
                      const on = app.requirements.includes(r.id) || locked;
                      return (
                        <label key={r.id} className="wiz-check-row">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={locked}
                            onChange={(e) =>
                              patch(i, {
                                requirements: e.target.checked
                                  ? [...app.requirements, r.id]
                                  : app.requirements.filter((x) => x !== r.id),
                              })
                            }
                          />
                          {r.label}
                        </label>
                      );
                    })}
                  </div>
                  <span className="hint">
                    {app.artifact.kind === "git"
                      ? app.artifact.runInDocker
                        ? "git and Docker are installed automatically for this GitHub source."
                        : "git is installed automatically to clone the repo."
                      : "Installed with apt before the app starts."}
                  </span>
                </div>
              </>
            ) : (
              <>
                <label className="wiz-field-wide">
                  Container image
                  <input
                    value={app.image}
                    onChange={(e) => patch(i, { image: e.target.value })}
                    placeholder="ghcr.io/acme/app:latest"
                  />
                </label>
                <label className="wiz-field-wide">
                  Command
                  <input
                    value={app.command}
                    onChange={(e) => patch(i, { command: e.target.value })}
                    placeholder="optional override"
                  />
                </label>
                <label>
                  Replicas
                  <input
                    type="number"
                    min={1}
                    value={app.replicas}
                    onChange={(e) => patch(i, { replicas: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Expose
                  <select
                    value={app.expose}
                    onChange={(e) => patch(i, { expose: e.target.value as "none" | "lb" })}
                  >
                    <option value="none">None</option>
                    <option value="lb">Load balancer</option>
                  </select>
                </label>
              </>
            )}

            <ConnectPicker
              label="Connect to clusters"
              hint="Injects REDIS_<CLUSTER>_HOST and admin credentials into the app environment."
              options={clusterNames}
              selected={app.connectClusters}
              onToggle={(cn, on) =>
                patch(i, {
                  connectClusters: on
                    ? [...app.connectClusters, cn]
                    : app.connectClusters.filter((x) => x !== cn),
                })
              }
            />
            <ConnectPicker
              label="Connect to databases"
              hint="Injects REDIS_<DB>_ENDPOINT into the app environment."
              options={databaseNames}
              selected={app.connectDatabases}
              onToggle={(cn, on) =>
                patch(i, {
                  connectDatabases: on
                    ? [...app.connectDatabases, cn]
                    : app.connectDatabases.filter((x) => x !== cn),
                })
              }
            />
            {mode === "vm" ? (
              <ConnectPicker
                label="Connect to load balancers"
                hint="Injects LB_<LB>_ENDPOINT (its VIP) into the app environment."
                options={loadBalancerNames}
                selected={app.connectLoadBalancers}
                onToggle={(cn, on) =>
                  patch(i, {
                    connectLoadBalancers: on
                      ? [...app.connectLoadBalancers, cn]
                      : app.connectLoadBalancers.filter((x) => x !== cn),
                  })
                }
              />
            ) : null}
            <ConnectPicker
              label="Connect to apps / VMs"
              hint="Injects <NAME>_HOST (the target's hostname) into the app environment."
              options={appHostNames.filter((n) => n !== (app.name.trim() || ""))}
              selected={app.connectApps}
              onToggle={(cn, on) =>
                patch(i, {
                  connectApps: on
                    ? [...app.connectApps, cn]
                    : app.connectApps.filter((x) => x !== cn),
                })
              }
            />
            <ConnectPicker
              label="Connect to storage"
              hint="Injects GCS_<BUCKET>_BUCKET / _URL and grants bucket access."
              options={storageNames}
              selected={app.connectStorage}
              onToggle={(cn, on) =>
                patch(i, {
                  connectStorage: on
                    ? [...app.connectStorage, cn]
                    : app.connectStorage.filter((x) => x !== cn),
                })
              }
            />
            <ConnectPicker
              label="Connect to Pub/Sub"
              hint="Injects PUBSUB_<TOPIC>_TOPIC / _SUBSCRIPTION and grants publish/subscribe."
              options={pubsubNames}
              selected={app.connectPubsub}
              onToggle={(cn, on) =>
                patch(i, {
                  connectPubsub: on
                    ? [...app.connectPubsub, cn]
                    : app.connectPubsub.filter((x) => x !== cn),
                })
              }
            />
            <ConnectPicker
              label="Connect to BigQuery"
              hint="Injects BIGQUERY_<DATASET>_DATASET and grants dataset + jobUser access."
              options={bigqueryNames}
              selected={app.connectBigquery}
              onToggle={(cn, on) =>
                patch(i, {
                  connectBigquery: on
                    ? [...app.connectBigquery, cn]
                    : app.connectBigquery.filter((x) => x !== cn),
                })
              }
            />
            <ConnectPicker
              label="Connect to Cloud SQL"
              hint={
                mode === "vm"
                  ? "Injects SQL_<NAME>_HOST / _CONNECTION_NAME / _DB / _USER / _PASSWORD and grants the Cloud SQL client role."
                  : "Injects SQL_<NAME>_CONNECTION_NAME / _DB / _USER / _PORT and grants the Cloud SQL client role (reach it via the Auth Proxy)."
              }
              options={cloudsqlNames}
              selected={app.connectSql}
              onToggle={(cn, on) =>
                patch(i, {
                  connectSql: on
                    ? [...app.connectSql, cn]
                    : app.connectSql.filter((x) => x !== cn),
                })
              }
            />

            <div className="wiz-field-wide">
              <span className="machine-picker-label">Environment variables</span>
              {app.env.map((row, r) => (
                <div className="wiz-env-row" key={r}>
                  <input
                    placeholder="KEY"
                    value={row.key}
                    onChange={(e) =>
                      patch(i, {
                        env: app.env.map((x, idx) => (idx === r ? { ...x, key: e.target.value } : x)),
                      })
                    }
                  />
                  <input
                    placeholder="value"
                    value={row.value}
                    onChange={(e) =>
                      patch(i, {
                        env: app.env.map((x, idx) => (idx === r ? { ...x, value: e.target.value } : x)),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => patch(i, { env: app.env.filter((_, idx) => idx !== r) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => patch(i, { env: [...app.env, { key: "", value: "" }] })}
                >
                  Add variable
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn"
          onClick={() => onChange([...applications, blankApplication(defaultMachineType)])}
        >
          Add application
        </button>
      </div>
    </div>
  );
}

/** Load balancers editor (VM mode only). */
export function LoadBalancerEditor({
  loadBalancers,
  onChange,
  appNames,
}: {
  loadBalancers: LbDraft[];
  onChange: (lbs: LbDraft[]) => void;
  appNames: string[];
}) {
  const patch = (i: number, p: Partial<LbDraft>) =>
    onChange(loadBalancers.map((lb, idx) => (idx === i ? { ...lb, ...p } : lb)));

  return (
    <div className="companion-block">
      <h3 className="companion-title">Load balancers (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Internal load balancers fronting an application or the set of App VMs.
      </p>

      {loadBalancers.map((lb, i) => (
        <div className="wiz-workload-card" key={`lb-${i}`}>
          <div className="wiz-workload-head">
            <h4>{lb.name.trim() || `Load balancer ${i + 1}`}</h4>
            <button
              type="button"
              className="btn"
              onClick={() => onChange(loadBalancers.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Name
              <input
                value={lb.name}
                onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })}
                placeholder="app-lb"
              />
            </label>
            <label>
              Target kind
              <select
                value={lb.target_kind}
                onChange={(e) => {
                  const kind = e.target.value as LbDraft["target_kind"];
                  patch(i, {
                    target_kind: kind,
                    target: kind === "vms" ? "app" : appNames[0] || "",
                  });
                }}
              >
                <option value="application">Application</option>
                <option value="vms">Set of VMs</option>
              </select>
            </label>
            {lb.target_kind === "application" ? (
              <label>
                Target application
                <select
                  value={lb.target}
                  onChange={(e) => patch(i, { target: e.target.value })}
                  disabled={!appNames.length}
                >
                  {appNames.length ? null : <option value="">Add an application first</option>}
                  {appNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Target
                <input value="app (set of VMs)" disabled readOnly />
              </label>
            )}
            <label>
              Ports
              <input
                value={lb.ports}
                onChange={(e) => patch(i, { ports: e.target.value })}
                placeholder="80, 443, 8080"
              />
              <span className="hint">Comma-separated ports opened on the load balancer.</span>
            </label>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => onChange([...loadBalancers, blankLb()])}>
          Add load balancer
        </button>
      </div>
    </div>
  );
}

/** Cloud Storage buckets editor (VM and GKE). */
export function StorageEditor({
  buckets,
  onChange,
  region,
}: {
  buckets: StorageDraft[];
  onChange: (buckets: StorageDraft[]) => void;
  region: string;
}) {
  const patch = (i: number, p: Partial<StorageDraft>) =>
    onChange(buckets.map((b, idx) => (idx === i ? { ...b, ...p } : b)));

  return (
    <div className="companion-block">
      <h3 className="companion-title">Cloud Storage (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Object storage buckets. Connect an application or the Set-of-VMs group to a bucket to inject its
        name/URL and grant access.
      </p>
      {buckets.map((b, i) => (
        <div className="wiz-workload-card" key={`bucket-${i}`}>
          <div className="wiz-workload-head">
            <h4>{b.name.trim() || `Bucket ${i + 1}`}</h4>
            <button type="button" className="btn" onClick={() => onChange(buckets.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Bucket name
              <input value={b.name} onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })} placeholder="assets" />
              <span className="hint">Prefixed with the deployment name for global uniqueness.</span>
            </label>
            <label>
              Location
              <select value={b.location} onChange={(e) => patch(i, { location: e.target.value })}>
                <option value="">Deployment region{region ? ` (${region})` : ""}</option>
                <option value="US">US (multi-region)</option>
                <option value="EU">EU (multi-region)</option>
                <option value="ASIA">ASIA (multi-region)</option>
              </select>
            </label>
            <label>
              Storage class
              <select
                value={b.storage_class}
                onChange={(e) => patch(i, { storage_class: e.target.value as StorageDraft["storage_class"] })}
              >
                <option value="STANDARD">Standard</option>
                <option value="NEARLINE">Nearline</option>
                <option value="COLDLINE">Coldline</option>
                <option value="ARCHIVE">Archive</option>
              </select>
            </label>
            <label>
              Access for connected components
              <select value={b.access} onChange={(e) => patch(i, { access: e.target.value as StorageDraft["access"] })}>
                <option value="readwrite">Read &amp; write</option>
                <option value="read">Read-only</option>
              </select>
            </label>
            <label className="wiz-check-row">
              <input type="checkbox" checked={b.versioning} onChange={(e) => patch(i, { versioning: e.target.checked })} />
              Object versioning
            </label>
            <label className="wiz-check-row">
              <input
                type="checkbox"
                checked={b.force_destroy}
                onChange={(e) => patch(i, { force_destroy: e.target.checked })}
              />
              Allow destroy of a non-empty bucket
            </label>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => onChange([...buckets, blankStorage()])}>
          Add bucket
        </button>
      </div>
    </div>
  );
}

/** Pub/Sub topics editor (VM and GKE). */
export function PubsubEditor({
  topics,
  onChange,
}: {
  topics: PubsubDraft[];
  onChange: (topics: PubsubDraft[]) => void;
}) {
  const patch = (i: number, p: Partial<PubsubDraft>) =>
    onChange(topics.map((t, idx) => (idx === i ? { ...t, ...p } : t)));

  return (
    <div className="companion-block">
      <h3 className="companion-title">Pub/Sub (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Topics (and optional subscriptions). Connect an application or the Set-of-VMs group to inject the
        topic/subscription names and grant publish/subscribe.
      </p>
      {topics.map((t, i) => (
        <div className="wiz-workload-card" key={`topic-${i}`}>
          <div className="wiz-workload-head">
            <h4>{t.name.trim() || `Topic ${i + 1}`}</h4>
            <button type="button" className="btn" onClick={() => onChange(topics.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Topic name
              <input value={t.name} onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })} placeholder="events" />
              <span className="hint">Prefixed with the deployment name.</span>
            </label>
            <label>
              Access for connected components
              <select value={t.role} onChange={(e) => patch(i, { role: e.target.value as PubsubDraft["role"] })}>
                <option value="both">Publish &amp; subscribe</option>
                <option value="publish">Publish only</option>
                <option value="subscribe">Subscribe only</option>
              </select>
            </label>
            <label className="wiz-check-row">
              <input
                type="checkbox"
                checked={t.create_subscription}
                onChange={(e) => patch(i, { create_subscription: e.target.checked })}
              />
              Create a pull subscription
            </label>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => onChange([...topics, blankPubsub()])}>
          Add topic
        </button>
      </div>
    </div>
  );
}

/** BigQuery datasets editor (VM and GKE). */
export function BigqueryEditor({
  datasets,
  onChange,
  region,
}: {
  datasets: BigqueryDraft[];
  onChange: (datasets: BigqueryDraft[]) => void;
  region: string;
}) {
  const patch = (i: number, p: Partial<BigqueryDraft>) =>
    onChange(datasets.map((d, idx) => (idx === i ? { ...d, ...p } : d)));

  return (
    <div className="companion-block">
      <h3 className="companion-title">BigQuery (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Datasets for analytics. Connect an application or the Set-of-VMs group to inject the dataset id and
        grant dataset + jobUser access.
      </p>
      {datasets.map((d, i) => (
        <div className="wiz-workload-card" key={`dataset-${i}`}>
          <div className="wiz-workload-head">
            <h4>{d.name.trim() || `Dataset ${i + 1}`}</h4>
            <button type="button" className="btn" onClick={() => onChange(datasets.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Dataset name
              <input value={d.name} onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })} placeholder="analytics" />
              <span className="hint">Dataset id is prefixed with the deployment name (underscores).</span>
            </label>
            <label>
              Location
              <select value={d.location} onChange={(e) => patch(i, { location: e.target.value })}>
                <option value="">Deployment region{region ? ` (${region})` : ""}</option>
                <option value="US">US (multi-region)</option>
                <option value="EU">EU (multi-region)</option>
              </select>
            </label>
            <label>
              Access for connected components
              <select value={d.access} onChange={(e) => patch(i, { access: e.target.value as BigqueryDraft["access"] })}>
                <option value="readwrite">Read &amp; write (dataEditor)</option>
                <option value="read">Read-only (dataViewer)</option>
              </select>
            </label>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => onChange([...datasets, blankBigquery()])}>
          Add dataset
        </button>
      </div>
    </div>
  );
}

/** Cloud SQL instances editor (VM and GKE). */
export function CloudSqlEditor({
  instances,
  onChange,
  region,
}: {
  instances: CloudSqlDraft[];
  onChange: (instances: CloudSqlDraft[]) => void;
  region: string;
}) {
  const patch = (i: number, p: Partial<CloudSqlDraft>) =>
    onChange(instances.map((d, idx) => (idx === i ? { ...d, ...p } : d)));

  return (
    <div className="companion-block">
      <h3 className="companion-title">Cloud SQL (optional)</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        Managed Postgres/MySQL instances{region ? ` in ${region}` : ""}. Connect an application or the
        Set-of-VMs group to inject the connection details and grant the Cloud SQL client role. The user
        password is generated and injected on VMs.
      </p>
      {instances.map((d, i) => (
        <div className="wiz-workload-card" key={`sql-${i}`}>
          <div className="wiz-workload-head">
            <h4>{d.name.trim() || `Instance ${i + 1}`}</h4>
            <button type="button" className="btn" onClick={() => onChange(instances.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <div className="grid grid-2">
            <label>
              Instance name
              <input value={d.name} onChange={(e) => patch(i, { name: e.target.value.slice(0, 40) })} placeholder="orders" />
              <span className="hint">Prefixed with the deployment name.</span>
            </label>
            <label>
              Engine
              <select value={d.engine} onChange={(e) => patch(i, { engine: e.target.value as CloudSqlDraft["engine"] })}>
                <option value="postgres">PostgreSQL 15</option>
                <option value="mysql">MySQL 8.0</option>
              </select>
            </label>
            <label>
              Tier
              <input value={d.tier} onChange={(e) => patch(i, { tier: e.target.value })} placeholder="db-f1-micro" />
              <span className="hint">Machine tier, e.g. db-f1-micro or db-custom-1-3840.</span>
            </label>
            <label>
              Connectivity
              <select
                value={d.connectivity}
                onChange={(e) => patch(i, { connectivity: e.target.value as CloudSqlDraft["connectivity"] })}
              >
                <option value="private">Private IP (VPC peering)</option>
                <option value="proxy">Public IP + Auth Proxy</option>
                <option value="public">Public IP + open networks</option>
              </select>
            </label>
            <label>
              Database name
              <input value={d.db_name} onChange={(e) => patch(i, { db_name: e.target.value.slice(0, 40) })} placeholder="appdb" />
            </label>
            <label>
              User
              <input value={d.db_user} onChange={(e) => patch(i, { db_user: e.target.value.slice(0, 40) })} placeholder="appuser" />
            </label>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => onChange([...instances, blankCloudSql()])}>
          Add instance
        </button>
      </div>
    </div>
  );
}

/** Redis Data Integration editor (VM and GKE): runtime + full pipeline editor. */
export function RdiEditor({
  rdi,
  onChange,
  databaseNames,
  cloudsqlNames,
}: {
  rdi: RdiDraft | null;
  onChange: (rdi: RdiDraft | null) => void;
  databaseNames: string[];
  cloudsqlNames: string[];
}) {
  if (!rdi) {
    return (
      <div className="companion-block">
        <h3 className="companion-title">Redis Data Integration (optional)</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          Ingest change data from Cloud SQL source(s) into a target Redis database.
        </p>
        <button type="button" className="btn" onClick={() => onChange(blankRdi())}>
          Add RDI
        </button>
      </div>
    );
  }

  const patch = (p: Partial<RdiDraft>) => onChange({ ...rdi, ...p });
  const toggleSource = (name: string, on: boolean) =>
    patch({
      pipelines: on
        ? [...rdi.pipelines, { source: name, tables: [] }]
        : rdi.pipelines.filter((p) => p.source !== name),
    });
  const patchPipeline = (i: number, tables: RdiTableDraft[]) =>
    patch({ pipelines: rdi.pipelines.map((p, idx) => (idx === i ? { ...p, tables } : p)) });

  return (
    <div className="companion-block">
      <div className="wiz-workload-head">
        <h3 className="companion-title" style={{ margin: 0 }}>
          Redis Data Integration
        </h3>
        <button type="button" className="btn" onClick={() => onChange(null)}>
          Remove RDI
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Ingest change data from Cloud SQL source(s) into a target Redis database. CDC is enabled on the
        selected sources; the pipeline-state database is created automatically in the target&apos;s cluster.
      </p>
      <div className="grid grid-2">
        <label>
          Name
          <input value={rdi.name} onChange={(e) => patch({ name: e.target.value.slice(0, 40) })} placeholder="ingest" />
        </label>
        <label>
          RDI VM machine type
          <input
            value={rdi.machine_type}
            onChange={(e) => patch({ machine_type: e.target.value })}
            placeholder="n2-standard-4"
          />
          <span className="hint">Used in VM mode.</span>
        </label>
        <label>
          Target Redis database
          <select value={rdi.target} onChange={(e) => patch({ target: e.target.value })} disabled={!databaseNames.length}>
            <option value="">{databaseNames.length ? "Select a target database" : "Add a database first"}</option>
            {databaseNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="hint">Where the pipeline writes. No target ⇒ RDI deploys but starts no pipeline.</span>
        </label>
      </div>
      <ConnectPicker
        label="Cloud SQL sources"
        hint="Each selected instance becomes a pipeline; CDC is enabled on it."
        options={cloudsqlNames}
        selected={rdi.pipelines.map((p) => p.source)}
        onToggle={toggleSource}
      />
      {rdi.pipelines.map((p, i) => (
        <RdiPipelineEditor key={p.source} pipeline={p} onChange={(tables) => patchPipeline(i, tables)} />
      ))}
    </div>
  );
}

/** Per-source table + target-key mapping editor, shown inside the RDI card. */
function RdiPipelineEditor({
  pipeline,
  onChange,
}: {
  pipeline: RdiPipelineDraft;
  onChange: (tables: RdiTableDraft[]) => void;
}) {
  const patch = (i: number, p: Partial<RdiTableDraft>) =>
    onChange(pipeline.tables.map((t, idx) => (idx === i ? { ...t, ...p } : t)));
  return (
    <div className="wiz-workload-card">
      <div className="wiz-workload-head">
        <h4>Pipeline · {pipeline.source}</h4>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Tables to ingest. Leave empty to ingest all tables with default key mapping.
      </p>
      {pipeline.tables.map((t, i) => (
        <div className="wiz-env-row" key={i}>
          <input
            placeholder="schema.table"
            value={t.table}
            onChange={(e) => patch(i, { table: e.target.value })}
          />
          <input
            placeholder="target key prefix (optional)"
            value={t.key_prefix}
            onChange={(e) => patch(i, { key_prefix: e.target.value })}
          />
          <button
            type="button"
            className="btn"
            onClick={() => onChange(pipeline.tables.filter((_, idx) => idx !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn" onClick={() => onChange([...pipeline.tables, { table: "", key_prefix: "" }])}>
          Add table
        </button>
      </div>
    </div>
  );
}
