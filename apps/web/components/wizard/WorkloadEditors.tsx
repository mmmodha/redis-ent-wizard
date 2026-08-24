"use client";

import { useState } from "react";
import { MachineTypePicker } from "@/components/MachineTypePicker";
import { uploadArtifact, type MachineTypeInfo } from "@/lib/api";
import {
  APP_REQUIREMENTS,
  DB_MODULES,
  EVICTION_POLICIES,
  type ArtifactSource,
} from "@/lib/diagram";

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

export function blankDatabase(): DatabaseDraft {
  return {
    name: "",
    memory_gb: 1,
    replication: true,
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

/** Per-cluster databases editor, shown inside each cluster card. */
export function DatabaseEditor({
  databases,
  onChange,
  clusterHasNvme,
}: {
  databases: DatabaseDraft[];
  onChange: (dbs: DatabaseDraft[]) => void;
  clusterHasNvme: boolean;
}) {
  const patch = (i: number, p: Partial<DatabaseDraft>) =>
    onChange(databases.map((d, idx) => (idx === i ? { ...d, ...p } : d)));

  return (
    <div className="wiz-field-wide">
      <span className="machine-picker-label">Databases</span>
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
            <label className="wiz-check-row">
              <input
                type="checkbox"
                checked={db.replication}
                onChange={(e) => patch(i, { replication: e.target.checked })}
              />
              Replication (HA)
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
        <button type="button" className="btn" onClick={() => onChange([...databases, blankDatabase()])}>
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
}: {
  applications: ApplicationDraft[];
  onChange: (apps: ApplicationDraft[]) => void;
  mode: Mode;
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
  defaultMachineType: string;
  clusterNames: string[];
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
                    {(["upload", "url", "gcs"] as const).map((k) => (
                      <label key={k} className="wiz-check-row">
                        <input
                          type="radio"
                          name={`artifact-kind-${i}`}
                          checked={app.artifact.kind === k}
                          onChange={() => patch(i, { artifact: { ...app.artifact, kind: k } })}
                        />
                        {k === "upload" ? "Upload" : k === "url" ? "URL" : "GCS path"}
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

                <label className="wiz-field-wide">
                  Command
                  <input
                    value={app.command}
                    onChange={(e) => patch(i, { command: e.target.value })}
                    placeholder="empty = stage only"
                  />
                  <span className="hint">Leave empty to stage the artifact without starting it.</span>
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
                      const on = app.requirements.includes(r.id);
                      return (
                        <label key={r.id} className="wiz-check-row">
                          <input
                            type="checkbox"
                            checked={on}
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
                  <span className="hint">Installed with apt before the app starts.</span>
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

            {clusterNames.length ? (
              <div className="wiz-field-wide">
                <span className="machine-picker-label">Connect to clusters</span>
                <div className="wiz-badges">
                  {clusterNames.map((cn) => {
                    const on = app.connectClusters.includes(cn);
                    return (
                      <label key={cn} className="wiz-check-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            patch(i, {
                              connectClusters: e.target.checked
                                ? [...app.connectClusters, cn]
                                : app.connectClusters.filter((x) => x !== cn),
                            })
                          }
                        />
                        {cn}
                      </label>
                    );
                  })}
                </div>
                <span className="hint">Injects the cluster endpoint into the app environment.</span>
              </div>
            ) : null}

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
