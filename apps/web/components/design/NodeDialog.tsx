"use client";

import { useEffect, useState } from "react";
import { MachineTypePicker } from "@/components/MachineTypePicker";
import { uploadArtifact, type MachineTypeInfo, type RsReleaseInfo } from "@/lib/api";
import {
  APP_REQUIREMENTS,
  ARTIFACT_SOURCE_OPTIONS,
  DB_MODULES,
  EVICTION_POLICIES,
  withGitSourceRequirements,
  type ApplicationData,
  type ClusterData,
  type DatabaseData,
  type DesignNodeData,
  type LoadBalancerData,
  type RootData,
  type VmsData,
} from "@/lib/diagram";
import { canEnableDbReplication, dbReplicationHint, effectiveDbReplication } from "@/lib/db-replication";
import { useDesignContext } from "@/components/design/DesignContext";
import { clusterTrialShardGate } from "@/lib/trial-shards";

export type DialogTarget = {
  id: string;
  type: string;
  data: DesignNodeData;
};

type Props = {
  target: DialogTarget;
  mode: "vm" | "gke";
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  vmReleases: RsReleaseInfo[];
  probeZone: string;
  /** Whether the database's parent cluster has NVMe disks (enables Flex). */
  clusterHasNvme?: boolean;
  /** Redis node count of the parent cluster (locks HA when < 2). */
  clusterNodes?: number;
  onSave: (data: DesignNodeData) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

const NVME_OPTIONS = [0, 1, 2, 4, 8];
const APP_DISK_OPTIONS = [0, 50, 100, 200, 500, 1000];

function inferType(filename: string): "jar" | "binary" {
  return filename.toLowerCase().endsWith(".jar") ? "jar" : "binary";
}

export function NodeDialog({
  target,
  mode,
  machineTypes,
  loadingMachines,
  vmReleases,
  probeZone,
  clusterHasNvme,
  clusterNodes = 0,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<DesignNodeData>(target.data);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setDraft(target.data);
  }, [target]);

  function set<T extends DesignNodeData>(patch: Partial<T>) {
    setDraft((prev) => ({ ...prev, ...patch }) as DesignNodeData);
  }

  const titles: Record<string, string> = {
    network: "VPC network",
    gke: "GKE cluster",
    cluster: "Redis cluster",
    database: "Database",
    vms: "Set of VMs",
    application: "Application",
    loadbalancer: "Load balancer",
  };

  return (
    <div className="design-modal-backdrop" role="dialog" aria-modal>
      <div className="design-modal">
        <div className="design-modal-head">
          <h3>{titles[target.type] || "Component"}</h3>
          <button type="button" className="design-modal-x" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>
        <div className="design-modal-body">
          {target.type === "gke" ? (
            <GkeRootForm
              data={draft as RootData}
              set={set}
              machineTypes={machineTypes}
              loadingMachines={loadingMachines}
              probeZone={probeZone}
            />
          ) : null}

          {target.type === "cluster" ? (
            <ClusterForm
              data={draft as ClusterData}
              set={set}
              mode={mode}
              machineTypes={machineTypes}
              loadingMachines={loadingMachines}
              probeZone={probeZone}
              vmReleases={vmReleases}
            />
          ) : null}

          {target.type === "database" ? (
            <DatabaseForm
              nodeId={target.id}
              data={draft as DatabaseData}
              set={set}
              clusterHasNvme={Boolean(clusterHasNvme)}
              clusterNodes={clusterNodes}
            />
          ) : null}

          {target.type === "vms" ? (
            <VmsForm
              data={draft as VmsData}
              set={set}
              machineTypes={machineTypes}
              loadingMachines={loadingMachines}
              probeZone={probeZone}
            />
          ) : null}

          {target.type === "application" ? (
            <ApplicationForm
              data={draft as ApplicationData}
              set={set}
              mode={mode}
              machineTypes={machineTypes}
              loadingMachines={loadingMachines}
              probeZone={probeZone}
              uploading={uploading}
              uploadError={uploadError}
              onUpload={async (file) => {
                setUploadError("");
                setUploading(true);
                try {
                  const artifact = await uploadArtifact(file);
                  set<ApplicationData>({
                    artifact: { kind: "upload", ref: artifact.id, type: artifact.type },
                  });
                } catch (err) {
                  setUploadError(err instanceof Error ? err.message : "Upload failed");
                } finally {
                  setUploading(false);
                }
              }}
            />
          ) : null}

          {target.type === "loadbalancer" ? (
            <LoadBalancerForm data={draft as LoadBalancerData} set={set} />
          ) : null}
        </div>
        <div className="design-modal-foot">
          {onDelete ? (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Remove
            </button>
          ) : (
            <span />
          )}
          <div className="design-modal-foot-right">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (draft.kind === "database") {
                  onSave({
                    ...draft,
                    replication: effectiveDbReplication(Boolean(draft.replication), clusterNodes),
                  });
                  return;
                }
                onSave(draft);
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GkeRootForm({
  data,
  set,
  machineTypes,
  loadingMachines,
  probeZone,
}: {
  data: RootData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
}) {
  return (
    <div className="grid">
      <MachineTypePicker
        label="GKE node machine type"
        value={data.gke_machine_type || ""}
        onChange={(v) => set<RootData>({ gke_machine_type: v })}
        machineTypes={machineTypes}
        loading={loadingMachines}
        preferredFamilies={["e2", "n2", "n2d"]}
        hint={`Types available in ${probeZone || "selected zone"}`}
      />
      <label>
        GKE nodes
        <select
          value={data.gke_clustersize ?? 3}
          onChange={(e) => set<RootData>({ gke_clustersize: Number(e.target.value) })}
        >
          {[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <option key={n} value={n}>
              {n} node{n > 1 ? "s" : ""}
            </option>
          ))}
        </select>
        <span className="hint">Needs at least as many nodes as the largest REC.</span>
      </label>
    </div>
  );
}

function ClusterForm({
  data,
  set,
  mode,
  machineTypes,
  loadingMachines,
  probeZone,
  vmReleases,
}: {
  data: ClusterData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
  mode: "vm" | "gke";
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
  vmReleases: RsReleaseInfo[];
}) {
  const maxSsd = machineTypes.find((m) => m.name === data.machine_type)?.maxLocalSsds ?? 24;
  return (
    <div className="grid">
      <label>
        Cluster name
        <input
          value={data.name}
          onChange={(e) => set<ClusterData>({ name: e.target.value.slice(0, 40) })}
          placeholder="cache"
        />
      </label>
      <label>
        {mode === "gke" ? "REC nodes" : "Cluster nodes"}
        <select
          value={mode === "gke" ? data.rec_nodes : data.nodes}
          onChange={(e) => {
            const n = Number(e.target.value);
            set<ClusterData>(mode === "gke" ? { rec_nodes: n } : { nodes: n });
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <option key={n} value={n}>
              {n} node{n > 1 ? "s" : ""}
            </option>
          ))}
        </select>
      </label>
      {mode === "vm" ? (
        <>
          <MachineTypePicker
            label="Redis node machine type"
            value={data.machine_type}
            onChange={(v) => set<ClusterData>({ machine_type: v })}
            machineTypes={machineTypes}
            loading={loadingMachines}
            showNvmeHint
            preferredFamilies={["e2", "n2", "n2d"]}
            hint={`Types available in ${probeZone || "selected zone"}`}
          />
          <label>
            Local NVMe disks per node
            <select
              value={data.rof_nvme_disks}
              onChange={(e) => set<ClusterData>({ rof_nvme_disks: Number(e.target.value) })}
            >
              {NVME_OPTIONS.map((n) => (
                <option key={n} value={n} disabled={n > maxSsd}>
                  {n === 0 ? "0 — RAM only" : `${n} × 375 GiB Local SSD`}
                  {n > maxSsd ? " (not supported)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">Optional Local SSD NVMe for Redis on Flash</span>
          </label>
          <label>
            Redis Enterprise version
            <select
              value={data.rs_version}
              onChange={(e) => set<ClusterData>({ rs_version: e.target.value })}
            >
              {(vmReleases.length ? vmReleases : [{ id: data.rs_version, label: data.rs_version, url: "" }]).map(
                (r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ),
              )}
            </select>
          </label>
        </>
      ) : (
        <p className="hint">Redis version and node sizing come from the GKE operator chart and node pool.</p>
      )}
      <label className="design-field-wide">
        License key
        <textarea
          value={data.license ?? ""}
          onChange={(e) => set<ClusterData>({ license: e.target.value })}
          rows={4}
          placeholder="optional"
        />
        <span className="hint">Optional. Leave blank to use the 4-shard trial license.</span>
      </label>
    </div>
  );
}

function DatabaseForm({
  nodeId,
  data,
  set,
  clusterHasNvme,
  clusterNodes,
}: {
  nodeId: string;
  data: DatabaseData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
  clusterHasNvme: boolean;
  clusterNodes: number;
}) {
  const { nodes } = useDesignContext();
  const parent = nodes.find((n) => n.id === nodes.find((x) => x.id === nodeId)?.parentId);
  const parentCluster = parent?.data.kind === "cluster" ? (parent.data as ClusterData) : undefined;
  const siblings = nodes
    .filter((n) => n.parentId === parent?.id && n.data.kind === "database" && n.id !== nodeId)
    .map((n) => n.data as DatabaseData);
  const trial = clusterTrialShardGate({
    name: parentCluster?.name,
    license: parentCluster?.license,
    databases: [...siblings, data],
    nodes: clusterNodes,
  });
  const allowReplication = canEnableDbReplication(clusterNodes);
  const replicationHint = dbReplicationHint(clusterNodes);
  return (
    <div className="grid">
      {trial.blocked ? <div className="notice notice-warn">{trial.message}</div> : null}
      <label>
        Database name
        <input
          value={data.name}
          onChange={(e) => set<DatabaseData>({ name: e.target.value.slice(0, 40) })}
          placeholder="cache-db"
        />
      </label>
      <label>
        Memory (GB)
        <input
          type="number"
          min={1}
          value={data.memory_gb}
          onChange={(e) => set<DatabaseData>({ memory_gb: Number(e.target.value) })}
        />
      </label>
      <label
        className="design-check-row"
        title={allowReplication ? undefined : replicationHint}
      >
        <input
          type="checkbox"
          disabled={!allowReplication}
          checked={allowReplication && data.replication}
          onChange={(e) => set<DatabaseData>({ replication: e.target.checked })}
        />
        Replication (HA){allowReplication ? "" : " — needs 2+ nodes on the cluster"}
      </label>
      <label
        className="design-check-row"
        title={clusterHasNvme ? undefined : "Add NVMe disks to the Redis cluster to enable Redis on Flash"}
      >
        <input
          type="checkbox"
          disabled={!clusterHasNvme}
          checked={clusterHasNvme && data.flex}
          onChange={(e) => set<DatabaseData>({ flex: e.target.checked })}
        />
        Flex (Redis on Flash){clusterHasNvme ? "" : " — needs NVMe on the cluster"}
      </label>
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.sharding}
          onChange={(e) => set<DatabaseData>({ sharding: e.target.checked })}
        />
        Sharding
      </label>
      {data.sharding ? (
        <label>
          Shards
          <input
            type="number"
            min={2}
            max={100}
            value={data.shards_count}
            onChange={(e) => set<DatabaseData>({ shards_count: Number(e.target.value) })}
          />
        </label>
      ) : (
        <div />
      )}
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.oss_cluster}
          onChange={(e) =>
            set<DatabaseData>(
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
          value={data.proxy_policy}
          disabled={data.oss_cluster}
          onChange={(e) =>
            set<DatabaseData>({ proxy_policy: e.target.value as DatabaseData["proxy_policy"] })
          }
        >
          <option value="single">Single proxy (one endpoint)</option>
          <option value="all-master-shards">All primary nodes</option>
        </select>
      </label>
      <label>
        Shards placement
        <select
          value={data.shards_placement}
          onChange={(e) =>
            set<DatabaseData>({ shards_placement: e.target.value as DatabaseData["shards_placement"] })
          }
        >
          <option value="dense">Dense (pack onto fewer nodes)</option>
          <option value="sparse">Sparse (spread across nodes)</option>
        </select>
      </label>
      <label>
        Eviction policy
        <select
          value={data.eviction_policy}
          onChange={(e) => set<DatabaseData>({ eviction_policy: e.target.value })}
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
          value={data.port}
          onChange={(e) => set<DatabaseData>({ port: Number(e.target.value) })}
        />
      </label>
      <label>
        Password
        <input
          type="text"
          value={data.password}
          onChange={(e) => set<DatabaseData>({ password: e.target.value })}
          placeholder="optional"
        />
      </label>
      <div className="design-field-wide">
        <span className="machine-picker-label">Modules</span>
        <div className="design-badges">
          {DB_MODULES.map((m) => {
            const on = data.modules.includes(m.id);
            return (
              <label key={m.id} className="design-check-row">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    set<DatabaseData>({
                      modules: e.target.checked
                        ? [...data.modules, m.id]
                        : data.modules.filter((x) => x !== m.id),
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
  );
}

function VmsForm({
  data,
  set,
  machineTypes,
  loadingMachines,
  probeZone,
}: {
  data: VmsData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
}) {
  return (
    <div className="grid">
      <label>
        Name
        <input
          value={data.name}
          onChange={(e) => set<VmsData>({ name: e.target.value.slice(0, 40) })}
          placeholder="clients"
        />
      </label>
      <label>
        Count
        <select value={data.count} onChange={(e) => set<VmsData>({ count: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} VM{n === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </label>
      <MachineTypePicker
        label="Machine type per VM"
        value={data.machine_type}
        onChange={(v) => set<VmsData>({ machine_type: v })}
        machineTypes={machineTypes}
        loading={loadingMachines}
        preferredFamilies={["n2", "e2", "n2d"]}
        hint={`Types available in ${probeZone || "selected zone"}`}
      />
      <label>
        Disk (GiB) per VM
        <select value={data.disk_gib} onChange={(e) => set<VmsData>({ disk_gib: Number(e.target.value) })}>
          {APP_DISK_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "None — boot disk only" : `${n} GiB at /data`}
            </option>
          ))}
        </select>
      </label>
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.memviz_enabled}
          onChange={(e) => set<VmsData>({ memviz_enabled: e.target.checked })}
        />
        Memviz (memtier visualizer)
      </label>
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.expose_http}
          onChange={(e) => set<VmsData>({ expose_http: e.target.checked })}
        />
        Expose HTTP (port 80)
      </label>
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.expose_https}
          onChange={(e) => set<VmsData>({ expose_https: e.target.checked })}
        />
        Expose HTTPS (port 443)
      </label>
      <label className="design-field-wide">
        Extra TCP ports
        <input
          value={data.extra_ports}
          onChange={(e) => set<VmsData>({ extra_ports: e.target.value })}
          placeholder="8080, 9090"
        />
        <span className="hint">Opened on the VMs from the internet. Comma separated.</span>
      </label>
    </div>
  );
}

function EnvRows({
  rows,
  onChange,
}: {
  rows: { key: string; value: string }[];
  onChange: (rows: { key: string; value: string }[]) => void;
}) {
  return (
    <div className="design-field-wide">
      <span className="machine-picker-label">Environment variables</span>
      {rows.map((row, i) => (
        <div className="design-env-row" key={i}>
          <input
            placeholder="KEY"
            value={row.key}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
          />
          <input
            placeholder="value"
            value={row.value}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
          />
          <button
            type="button"
            className="btn"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        Add variable
      </button>
    </div>
  );
}

function ApplicationForm({
  data,
  set,
  mode,
  machineTypes,
  loadingMachines,
  probeZone,
  uploading,
  uploadError,
  onUpload,
}: {
  data: ApplicationData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
  mode: "vm" | "gke";
  machineTypes: MachineTypeInfo[];
  loadingMachines?: boolean;
  probeZone: string;
  uploading: boolean;
  uploadError: string;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="grid">
      <label>
        Name
        <input
          value={data.name}
          onChange={(e) => set<ApplicationData>({ name: e.target.value.slice(0, 40) })}
          placeholder="loadgen"
        />
      </label>

      {mode === "vm" ? (
        <>
          <div className="design-field-wide">
            <span className="machine-picker-label">Artifact source</span>
            <div className="design-radio-row">
              {ARTIFACT_SOURCE_OPTIONS.map((opt) => (
                <label key={opt.kind} className="design-check-row">
                  <input
                    type="radio"
                    name="artifact-kind"
                    checked={data.artifact.kind === opt.kind}
                    onChange={() =>
                      set<ApplicationData>({
                        artifact: {
                          ...data.artifact,
                          kind: opt.kind,
                          runInDocker: opt.kind === "git" ? Boolean(data.artifact.runInDocker) : false,
                        },
                        requirements:
                          opt.kind === "git"
                            ? withGitSourceRequirements(data.requirements, Boolean(data.artifact.runInDocker))
                            : data.requirements,
                      })
                    }
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {data.artifact.kind === "upload" ? (
            <div className="design-field-wide">
              <label>
                Upload artifact
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      set<ApplicationData>({
                        artifact: { ...data.artifact, type: inferType(file.name) },
                      });
                      onUpload(file);
                    }
                  }}
                />
              </label>
              {uploading ? <span className="hint">Uploading…</span> : null}
              {uploadError ? <span className="field-error">{uploadError}</span> : null}
              {data.artifact.ref ? (
                <span className="hint mono">stored: {data.artifact.ref}</span>
              ) : null}
            </div>
          ) : data.artifact.kind === "git" ? (
            <>
              <label className="design-field-wide">
                GitHub URL
                <input
                  value={data.artifact.ref}
                  onChange={(e) =>
                    set<ApplicationData>({
                      artifact: { ...data.artifact, ref: e.target.value, type: "binary" },
                    })
                  }
                  placeholder="https://github.com/org/repo"
                />
              </label>
              <label>
                Branch or tag
                <input
                  value={data.artifact.branch || ""}
                  onChange={(e) =>
                    set<ApplicationData>({
                      artifact: { ...data.artifact, branch: e.target.value },
                    })
                  }
                  placeholder="default branch"
                />
              </label>
              <label className="design-check-row design-field-wide">
                <input
                  type="checkbox"
                  checked={Boolean(data.artifact.runInDocker)}
                  onChange={(e) =>
                    set<ApplicationData>({
                      artifact: { ...data.artifact, runInDocker: e.target.checked },
                      requirements: withGitSourceRequirements(data.requirements, e.target.checked),
                    })
                  }
                />
                Run with Docker
              </label>
              <p className="hint design-field-wide">
                The VM clones this repo into /opt/app and installs git.
                {data.artifact.runInDocker
                  ? " Docker is installed so you can run Compose or docker run."
                  : " Turn on Docker only if the app should run in a container."}
              </p>
            </>
          ) : (
            <label className="design-field-wide">
              {data.artifact.kind === "url" ? "Artifact URL" : "GCS path"}
              <input
                value={data.artifact.ref}
                onChange={(e) =>
                  set<ApplicationData>({
                    artifact: {
                      ...data.artifact,
                      ref: e.target.value,
                      type: inferType(e.target.value),
                    },
                  })
                }
                placeholder={data.artifact.kind === "url" ? "https://…/app.jar" : "gs://bucket/app.jar"}
              />
            </label>
          )}

          {data.artifact.kind === "git" ? null : (
          <label>
            Artifact type
            <select
              value={data.artifact.type}
              onChange={(e) =>
                set<ApplicationData>({
                  artifact: { ...data.artifact, type: e.target.value as "jar" | "binary" },
                })
              }
            >
              <option value="jar">jar</option>
              <option value="binary">binary</option>
            </select>
          </label>
          )}

          <label className="design-field-wide">
            Command
            <input
              value={data.command}
              onChange={(e) => set<ApplicationData>({ command: e.target.value })}
              placeholder={
                data.artifact.kind === "git" && data.artifact.runInDocker
                  ? "HTTP_PORT=8080 docker compose up --build"
                  : "empty = stage only"
              }
            />
            <span className="hint">
              {data.artifact.kind === "git"
                ? "Runs from the cloned repo in /opt/app. Leave empty to clone without starting."
                : "Leave empty to stage the artifact without starting it."}
            </span>
          </label>

          <label>
            VM count
            <select
              value={data.vm_count}
              onChange={(e) => set<ApplicationData>({ vm_count: Number(e.target.value) })}
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
            value={data.machine_type}
            onChange={(v) => set<ApplicationData>({ machine_type: v })}
            machineTypes={machineTypes}
            loading={loadingMachines}
            preferredFamilies={["n2", "e2", "n2d"]}
            hint={`Types available in ${probeZone || "selected zone"}`}
          />

          <label>
            Disk (GiB)
            <select
              value={data.disk_gib}
              onChange={(e) => set<ApplicationData>({ disk_gib: Number(e.target.value) })}
            >
              {APP_DISK_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "None — boot disk only" : `${n} GiB at /data`}
                </option>
              ))}
            </select>
          </label>

          <div className="design-field-wide">
            <span className="machine-picker-label">Requirements to install</span>
            <div className="design-badges">
              {APP_REQUIREMENTS.map((r) => {
                const requiredGit = data.artifact.kind === "git" && r.id === "git";
                const requiredDocker =
                  data.artifact.kind === "git" && data.artifact.runInDocker && r.id === "docker";
                const locked = requiredGit || requiredDocker;
                const on = data.requirements.includes(r.id) || locked;
                return (
                  <label key={r.id} className="design-check-row">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={locked}
                      onChange={(e) =>
                        set<ApplicationData>({
                          requirements: e.target.checked
                            ? [...data.requirements, r.id]
                            : data.requirements.filter((x) => x !== r.id),
                        })
                      }
                    />
                    {r.label}
                  </label>
                );
              })}
            </div>
            <span className="hint">
              {data.artifact.kind === "git"
                ? data.artifact.runInDocker
                  ? "git and Docker are installed automatically for this GitHub source."
                  : "git is installed automatically to clone the repo."
                : "Installed with apt before the app starts."}
            </span>
          </div>
        </>
      ) : (
        <>
          <label className="design-field-wide">
            Container image
            <input
              value={data.image}
              onChange={(e) => set<ApplicationData>({ image: e.target.value })}
              placeholder="ghcr.io/acme/app:latest"
            />
          </label>
          <label className="design-field-wide">
            Command
            <input
              value={data.command}
              onChange={(e) => set<ApplicationData>({ command: e.target.value })}
              placeholder="optional override"
            />
          </label>
          <label>
            Replicas
            <input
              type="number"
              min={1}
              value={data.replicas}
              onChange={(e) => set<ApplicationData>({ replicas: Number(e.target.value) })}
            />
          </label>
          <label>
            Expose
            <select
              value={data.expose}
              onChange={(e) => set<ApplicationData>({ expose: e.target.value as "none" | "lb" })}
            >
              <option value="none">None</option>
              <option value="lb">Load balancer</option>
            </select>
          </label>
        </>
      )}

      <label className="design-field-wide">
        Ports
        <input
          value={data.ports}
          onChange={(e) => set<ApplicationData>({ ports: e.target.value })}
          placeholder="8080, 9090"
        />
        <span className="hint">Comma-separated ports exposed by the app.</span>
      </label>

      <EnvRows rows={data.env} onChange={(env) => set<ApplicationData>({ env })} />
    </div>
  );
}

function LoadBalancerForm({
  data,
  set,
}: {
  data: LoadBalancerData;
  set: <T extends DesignNodeData>(p: Partial<T>) => void;
}) {
  return (
    <div className="grid">
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.expose_http}
          onChange={(e) => set<LoadBalancerData>({ expose_http: e.target.checked })}
        />
        Expose HTTP (port 80)
      </label>
      <label className="design-check-row">
        <input
          type="checkbox"
          checked={data.expose_https}
          onChange={(e) => set<LoadBalancerData>({ expose_https: e.target.checked })}
        />
        Expose HTTPS (port 443)
      </label>
      <label className="design-field-wide">
        Extra ports
        <input
          value={data.extra_ports}
          onChange={(e) => set<LoadBalancerData>({ extra_ports: e.target.value })}
          placeholder="8080, 9090"
        />
        <span className="hint">Comma-separated ports or ranges opened from the internet.</span>
      </label>
    </div>
  );
}
