"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MachineTypePicker } from "@/components/MachineTypePicker";
import {
  ApplicationsEditor,
  BigqueryEditor,
  CloudSqlEditor,
  CollapsibleSection,
  DatabaseEditor,
  LoadBalancerEditor,
  PubsubEditor,
  RdiEditor,
  StorageEditor,
  VmsConnectEditor,
  bigqueryDraftFromConfig,
  cloudsqlDraftFromConfig,
  databaseDraftFromConfig,
  pubsubDraftFromConfig,
  rdiDraftFromConfig,
  storageDraftFromConfig,
  type ApplicationDraft,
  type BigqueryDraft,
  type CloudSqlDraft,
  type DatabaseDraft,
  type LbDraft,
  type PubsubDraft,
  type RdiDraft,
  type StorageDraft,
} from "@/components/wizard/WorkloadEditors";
import { parsePorts, type DesignSettings } from "@/lib/diagram";
import type { UseGcpLookups } from "@/lib/useGcpLookups";
import { canEnableDbReplication, effectiveDbReplication } from "@/lib/db-replication";
import { clusterTrialShardGate, omitCreateInputDatabases } from "@/lib/trial-shards";
import { type PreflightResult } from "@/lib/api";

type Mode = "vm" | "gke";

const LOCAL_SSD_GIB = 375;
const APP_DISK_GIB_OPTIONS = [0, 50, 100, 200, 500, 1000];
const DEFAULT_RS_VERSION = "8.2.0-46";

type ClusterDraft = {
  name: string;
  nodes: number;
  machine_type: string;
  rof_nvme_disks: number;
  rs_version: string;
  rec_nodes: number;
  RS_admin: string;
  license: string;
  databases: DatabaseDraft[];
};

type StoredCluster = {
  name?: string;
  nodes?: number;
  machine_type?: string;
  rof_nvme_disks?: number;
  rs_version?: string;
  rec_nodes?: number;
  RS_admin?: string;
  license?: string;
  databases?: Record<string, unknown>[];
};

function blankCluster(machine = ""): ClusterDraft {
  return {
    name: "",
    nodes: 3,
    machine_type: machine,
    rof_nvme_disks: 0,
    rs_version: DEFAULT_RS_VERSION,
    rec_nodes: 3,
    RS_admin: "admin@redis.io",
    license: "",
    databases: [],
  };
}

/** Normalize database drafts into the backend shape, mirroring the designer. */
function databasesToPayload(dbs: DatabaseDraft[], clusterNodes: number): Record<string, unknown>[] {
  return dbs.map((d) => ({
    name: d.name.trim() || "db",
    memory_gb: Number(d.memory_gb),
    replication: effectiveDbReplication(Boolean(d.replication), clusterNodes),
    sharding: Boolean(d.sharding),
    shards_count: d.sharding ? Number(d.shards_count) : 1,
    eviction_policy: d.eviction_policy,
    port: Number(d.port),
    password: d.password,
    modules: d.modules,
    proxy_policy: d.proxy_policy,
    shards_placement: d.shards_placement,
    oss_cluster: Boolean(d.oss_cluster),
    flex: Boolean(d.flex),
  }));
}

function clusterSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
}

function previewClusterPrefix(instance: string, env: string, name: string, index: number): string {
  const base = `${instance || "instance"}-${env || "default"}`;
  const slug = clusterSlug(name);
  if (slug) return `${base}-${slug}`;
  return index <= 0 ? base : `${base}-c${index + 1}`;
}

function extraPortsLooksValid(value: string): boolean {
  if (!value.trim()) return true;
  return /^[\d\s,;\-]+$/.test(value);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Number(x) || 0) : [];
}

function extraPortsToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return "";
}

function clusterDraftFromConfig(c: StoredCluster, fallbackAdmin = ""): ClusterDraft {
  return {
    name: c.name || "",
    nodes: Number(c.nodes ?? c.rec_nodes ?? 3) || 3,
    machine_type: c.machine_type || "",
    rof_nvme_disks: Number(c.rof_nvme_disks ?? 0) || 0,
    rs_version: c.rs_version || DEFAULT_RS_VERSION,
    rec_nodes: Number(c.rec_nodes ?? c.nodes ?? 3) || 3,
    RS_admin: c.RS_admin || fallbackAdmin || "admin@redis.io",
    license: c.license || "",
    databases: Array.isArray(c.databases) ? c.databases.map(databaseDraftFromConfig) : [],
  };
}

type WizardForm = {
  name: string;
  youremail: string;
  skip_deletion: boolean;
  project: string;
  credentialsFile: string;
  region_name: string;
  env: string;
  folder: string;
  mode: Mode;
  region_zones: string[];
  clustersize: number;
  machine_type: string;
  rof_nvme_disks: number;
  clusters: ClusterDraft[];
  applications: ApplicationDraft[];
  load_balancers: LbDraft[];
  storage_buckets: StorageDraft[];
  pubsub_topics: PubsubDraft[];
  bigquery_datasets: BigqueryDraft[];
  cloud_sql_instances: CloudSqlDraft[];
  rdi: RdiDraft | null;
  vms_connect: {
    clusters: string[];
    databases: string[];
    load_balancers: string[];
    apps: string[];
    storage: string[];
    pubsub: string[];
    bigquery: string[];
    sql: string[];
  };
  app: number;
  app_machine_types: string[];
  memviz_enabled: boolean;
  app_expose_http: boolean;
  app_expose_https: boolean;
  app_disk_gib: number[];
  app_extra_ports: string;
  gke_clustersize: number;
  gke_machine_type: string;
  rec_nodes: number;
  operator_chart_version: string;
  dns_managed_zone: string;
  dns_zone_dns_name: string;
};

function applicationDraftFromConfig(a: Record<string, unknown>): ApplicationDraft {
  const artifact = (a.artifact as Record<string, unknown> | undefined) || {};
  const env =
    a.env && typeof a.env === "object"
      ? Object.entries(a.env as Record<string, unknown>).map(([key, value]) => ({
          key,
          value: String(value),
        }))
      : [];
  return {
    name: str(a.name),
    command: str(a.command),
    ports: Array.isArray(a.ports) ? a.ports.map(String).join(", ") : "",
    env,
    connectClusters: strArray(a.connectClusters),
    connectDatabases: strArray(a.connectDatabases),
    connectLoadBalancers: strArray(a.connectLoadBalancers),
    connectApps: strArray(a.connectApps),
    connectStorage: strArray(a.connectStorage),
    connectPubsub: strArray(a.connectPubsub),
    connectBigquery: strArray(a.connectBigquery),
    connectSql: strArray(a.connectSql),
    requirements: strArray(a.requirements),
    artifact: {
      kind:
        artifact.kind === "url" || artifact.kind === "gcs" || artifact.kind === "git"
          ? (artifact.kind as "url" | "gcs" | "git")
          : "upload",
      ref: str(artifact.ref),
      type: artifact.type === "binary" ? "binary" : "jar",
      branch: str(artifact.branch),
      runInDocker: Boolean(artifact.runInDocker),
    },
    vm_count: Number(a.vm_count) || 1,
    machine_type: str(a.machine_type),
    disk_gib: Number(a.disk_gib) || 0,
    image: str(a.image),
    replicas: Number(a.replicas) || 1,
    expose: a.expose === "lb" ? "lb" : "none",
  };
}

function lbDraftFromConfig(lb: Record<string, unknown>): LbDraft {
  return {
    name: str(lb.name),
    target: str(lb.target) || "app",
    target_kind: lb.target_kind === "application" ? "application" : "vms",
    ports: Array.isArray(lb.ports) ? lb.ports.map(String).join(", ") : extraPortsToString(lb.ports),
  };
}

/** Invert `payload()` — rebuild the wizard form from a stored create-config. */
function formFromConfig(
  prev: WizardForm,
  cfg: Record<string, unknown>,
  credentialsFile: string,
): WizardForm {
  const mode: Mode = cfg.mode === "gke" ? "gke" : "vm";
  const rawClusters = Array.isArray(cfg.clusters) ? (cfg.clusters as StoredCluster[]) : [];
  const redisOff =
    mode === "vm" && (cfg.redis_enabled === false || (Array.isArray(cfg.clusters) && rawClusters.length === 0));
  const clusters: ClusterDraft[] = redisOff
    ? []
    : rawClusters.length
      ? rawClusters.map((c) => clusterDraftFromConfig(c, str(cfg.RS_admin)))
      : [
          clusterDraftFromConfig(
            {
              name: undefined,
              nodes: Number(cfg.clustersize) || 3,
              machine_type: str(cfg.machine_type),
              rof_nvme_disks: Number(cfg.rof_nvme_disks) || 0,
              rs_version: str(cfg.rs_version) || DEFAULT_RS_VERSION,
              rec_nodes: Number(cfg.rec_nodes) || 3,
            },
            str(cfg.RS_admin),
          ),
        ];
  const zones = strArray(cfg.region_zones);
  return {
    ...prev,
    name: str(cfg.name),
    youremail: str(cfg.youremail),
    skip_deletion: Boolean(cfg.skip_deletion),
    project: str(cfg.project),
    credentialsFile,
    region_name: str(cfg.region_name),
    env: str(cfg.env) || "default",
    folder: str(cfg.folder),
    mode,
    region_zones: zones.length ? zones : prev.region_zones,
    clustersize: Number(cfg.clustersize) || clusters[0]?.nodes || 3,
    machine_type: str(cfg.machine_type) || clusters[0]?.machine_type || "",
    rof_nvme_disks: Number(cfg.rof_nvme_disks) || clusters[0]?.rof_nvme_disks || 0,
    clusters,
    applications: Array.isArray(cfg.applications)
      ? (cfg.applications as Record<string, unknown>[]).map(applicationDraftFromConfig)
      : [],
    load_balancers: Array.isArray(cfg.load_balancers)
      ? (cfg.load_balancers as Record<string, unknown>[]).map(lbDraftFromConfig)
      : [],
    storage_buckets: Array.isArray(cfg.storage_buckets)
      ? (cfg.storage_buckets as Record<string, unknown>[]).map(storageDraftFromConfig)
      : [],
    pubsub_topics: Array.isArray(cfg.pubsub_topics)
      ? (cfg.pubsub_topics as Record<string, unknown>[]).map(pubsubDraftFromConfig)
      : [],
    bigquery_datasets: Array.isArray(cfg.bigquery_datasets)
      ? (cfg.bigquery_datasets as Record<string, unknown>[]).map(bigqueryDraftFromConfig)
      : [],
    cloud_sql_instances: Array.isArray(cfg.cloud_sql_instances)
      ? (cfg.cloud_sql_instances as Record<string, unknown>[]).map(cloudsqlDraftFromConfig)
      : [],
    rdi:
      cfg.rdi && typeof cfg.rdi === "object"
        ? rdiDraftFromConfig(cfg.rdi as Record<string, unknown>)
        : null,
    vms_connect: (() => {
      const vc = (cfg.vms_connect as Record<string, unknown> | undefined) || {};
      return {
        clusters: strArray(vc.clusters),
        databases: strArray(vc.databases),
        load_balancers: strArray(vc.load_balancers),
        apps: strArray(vc.apps),
        storage: strArray(vc.storage),
        pubsub: strArray(vc.pubsub),
        bigquery: strArray(vc.bigquery),
        sql: strArray(vc.sql),
      };
    })(),
    app: Number(cfg.app) || 0,
    app_machine_types: strArray(cfg.app_machine_types),
    memviz_enabled: Boolean(cfg.memviz_enabled),
    app_expose_http: Boolean(cfg.app_expose_http),
    app_expose_https: Boolean(cfg.app_expose_https),
    app_disk_gib: numArray(cfg.app_disk_gib),
    app_extra_ports: extraPortsToString(cfg.app_extra_ports),
    gke_clustersize: Number(cfg.gke_clustersize) || clusters[0]?.rec_nodes || 3,
    gke_machine_type: str(cfg.gke_machine_type),
    rec_nodes: Number(cfg.rec_nodes) || clusters[0]?.rec_nodes || 3,
    operator_chart_version: str(cfg.operator_chart_version) || "latest",
    dns_managed_zone: str(cfg.dns_managed_zone),
    dns_zone_dns_name: str(cfg.dns_zone_dns_name),
  };
}

/** The blank workload form; settings fields are mirrored in from the shell. */
function blankForm(): WizardForm {
  return {
    name: "",
    youremail: "",
    skip_deletion: false,
    project: "",
    credentialsFile: "",
    region_name: "",
    env: "default",
    folder: "",
    mode: "vm",
    region_zones: ["b", "c", "d"],
    clustersize: 3,
    machine_type: "",
    rof_nvme_disks: 0,
    clusters: [],
    applications: [],
    load_balancers: [],
    storage_buckets: [],
    pubsub_topics: [],
    bigquery_datasets: [],
    cloud_sql_instances: [],
    rdi: null,
    vms_connect: {
      clusters: [],
      databases: [],
      load_balancers: [],
      apps: [],
      storage: [],
      pubsub: [],
      bigquery: [],
      sql: [],
    },
    app: 0,
    app_machine_types: [],
    memviz_enabled: false,
    app_expose_http: false,
    app_expose_https: false,
    app_disk_gib: [],
    app_extra_ports: "",
    gke_clustersize: 3,
    gke_machine_type: "",
    rec_nodes: 3,
    operator_chart_version: "latest",
    dns_managed_zone: "",
    dns_zone_dns_name: "",
  };
}

/**
 * Wizard half of the unified create workspace. Deployment settings, lookups, the
 * action bar and preflight are owned by the parent shell; this view renders only
 * the workload editors, mirrors the shared settings into its form, hydrates from
 * `initialConfig`, and reports the current create config + any upload in flight.
 */
export function WizardView({
  gcp,
  settings,
  initialConfig,
  onConfigChange,
  onUploadingChange,
}: {
  gcp: UseGcpLookups;
  settings: DesignSettings;
  initialConfig: Record<string, unknown> | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onUploadingChange: (uploading: boolean) => void;
}) {
  const { machineTypes, vmReleases, loading, probeZone } = gcp;
  const step = 2 as const; // the shell owns settings + review; this is the workload step.

  const [form, setForm] = useState<WizardForm>(() =>
    initialConfig && Object.keys(initialConfig).length
      ? formFromConfig(blankForm(), initialConfig, settings.credentialsFile)
      : blankForm(),
  );

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  // No-op preflight setter: the shell owns preflight, but the workload editors
  // still call this on edit. Keeping it avoids touching every onChange handler.
  const setPreflightResult = (v?: PreflightResult | null) => {
    void v;
  };
  void setPreflightResult;

  // Mirror the shared settings into the form so payload() stays a pure function
  // of `form`, while the shell's DeploymentSettings remains the single source.
  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      name: settings.name,
      env: settings.env,
      folder: settings.folder,
      youremail: settings.youremail,
      skip_deletion: settings.skip_deletion,
      project: settings.project,
      credentialsFile: settings.credentialsFile,
      region_name: settings.region_name,
      region_zones: settings.region_zones,
      mode: settings.mode,
      operator_chart_version: settings.operator_chart_version,
      dns_managed_zone: settings.dns_managed_zone,
      dns_zone_dns_name: settings.dns_zone_dns_name,
    }));
  }, [settings]);

  // Connect-target names for applications, matching the designer's clusterName().
  const clusterConnectNames = useMemo(
    () => form.clusters.map((c, i) => clusterSlug(c.name) || `cluster${i + 1}`),
    [form.clusters],
  );

  const appDefaultMachineType = useMemo(
    () =>
      machineTypes.find((m) => m.name === "n2-standard-8")?.name ||
      machineTypes.find((m) => m.name === "e2-standard-4")?.name ||
      machineTypes[0]?.name ||
      "",
    [machineTypes],
  );

  const appNames = useMemo(
    () => form.applications.map((a) => a.name.trim()).filter(Boolean),
    [form.applications],
  );

  // Connectable provider names for the application/Set-of-VMs multi-selects.
  const databaseConnectNames = useMemo(
    () => form.clusters.flatMap((c) => c.databases.map((d) => d.name.trim()).filter(Boolean)),
    [form.clusters],
  );
  const lbConnectNames = useMemo(
    () =>
      form.load_balancers
        .map((lb) => lb.name.trim() || `${lb.target_kind === "vms" ? "app" : lb.target}-lb`)
        .filter(Boolean),
    [form.load_balancers],
  );
  // Host providers: named applications, plus the Set-of-VMs group ("app").
  const appHostConnectNames = useMemo(
    () => [...(form.app > 0 ? ["app"] : []), ...appNames],
    [form.app, appNames],
  );
  const storageConnectNames = useMemo(
    () => form.storage_buckets.map((b) => b.name.trim()).filter(Boolean),
    [form.storage_buckets],
  );
  const pubsubConnectNames = useMemo(
    () => form.pubsub_topics.map((t) => t.name.trim()).filter(Boolean),
    [form.pubsub_topics],
  );
  const bigqueryConnectNames = useMemo(
    () => form.bigquery_datasets.map((d) => d.name.trim()).filter(Boolean),
    [form.bigquery_datasets],
  );
  const cloudsqlConnectNames = useMemo(
    () => form.cloud_sql_instances.map((d) => d.name.trim()).filter(Boolean),
    [form.cloud_sql_instances],
  );

  // Default machine types once the shared lookups resolve (mirrors the old
  // inline machine cascade, now sourced from the shell's useGcpLookups).
  useEffect(() => {
    const list = machineTypes;
    if (!list.length) return;
    setForm((prev) => ({
      ...prev,
      machine_type:
        prev.machine_type && list.some((m) => m.name === prev.machine_type)
          ? prev.machine_type
          : list.some((m) => m.name === "e2-standard-2")
            ? "e2-standard-2"
            : list[0]?.name || "",
      gke_machine_type:
        prev.gke_machine_type && list.some((m) => m.name === prev.gke_machine_type)
          ? prev.gke_machine_type
          : list.some((m) => m.name === "e2-standard-8")
            ? "e2-standard-8"
            : list[0]?.name || "",
      clusters: prev.clusters.map((c) => ({
        ...c,
        machine_type:
          c.machine_type && list.some((m) => m.name === c.machine_type)
            ? c.machine_type
            : list.some((m) => m.name === "e2-standard-2")
              ? "e2-standard-2"
              : list[0]?.name || "",
      })),
      app_machine_types: (() => {
        const fallback = list.some((m) => m.name === "n2-standard-8")
          ? "n2-standard-8"
          : list.some((m) => m.name === "e2-standard-4")
            ? "e2-standard-4"
            : list[0]?.name || "";
        if (!prev.app) return [];
        return Array.from({ length: prev.app }, (_, i) => {
          const cur = prev.app_machine_types[i];
          return cur && list.some((m) => m.name === cur) ? cur : fallback;
        });
      })(),
    }));
  }, [machineTypes]);

  const payload = useCallback(() => {
    const base: Record<string, unknown> = {
      name: form.name,
      mode: form.mode,
      youremail: form.youremail,
      skip_deletion: form.skip_deletion,
      redis_enabled: form.mode === "vm" ? form.clusters.length > 0 : true,
      project: form.project,
      credentialsFile: form.credentialsFile,
      region_name: form.region_name,
      env: form.env,
      folder: form.folder.trim() || undefined,
      region_zones: form.region_zones,
    };

    const applications = form.applications.map((a) => {
      const ports = parsePorts(a.ports);
      const env: Record<string, string> = {};
      for (const row of a.env) {
        const key = row.key.trim();
        if (key) env[key] = row.value;
      }
      const app: Record<string, unknown> = { name: a.name.trim() || "app" };
      if (a.command.trim()) app.command = a.command.trim();
      if (ports.length) app.ports = ports;
      if (Object.keys(env).length) app.env = env;
      if (a.connectClusters.length) app.connectClusters = a.connectClusters;
      if (a.connectDatabases.length) app.connectDatabases = a.connectDatabases;
      if (form.mode === "vm" && a.connectLoadBalancers.length)
        app.connectLoadBalancers = a.connectLoadBalancers;
      if (a.connectApps.length) app.connectApps = a.connectApps;
      if (a.connectStorage.length) app.connectStorage = a.connectStorage;
      if (a.connectPubsub.length) app.connectPubsub = a.connectPubsub;
      if (a.connectBigquery.length) app.connectBigquery = a.connectBigquery;
      if (a.connectSql.length) app.connectSql = a.connectSql;
      if (a.requirements.length) app.requirements = a.requirements;
      if (form.mode === "vm") {
        Object.assign(app, {
          artifact: {
            kind: a.artifact.kind,
            ref: a.artifact.ref,
            type: a.artifact.type,
            ...(a.artifact.kind === "git" && a.artifact.branch ? { branch: a.artifact.branch } : {}),
            ...(a.artifact.kind === "git" ? { runInDocker: Boolean(a.artifact.runInDocker) } : {}),
          },
          vm_count: Number(a.vm_count),
          machine_type: a.machine_type,
          disk_gib: Number(a.disk_gib),
        });
      } else {
        Object.assign(app, { image: a.image, replicas: Number(a.replicas), expose: a.expose });
      }
      return app;
    });
    if (applications.length) base.applications = applications;

    const storageBuckets = form.storage_buckets
      .map((b) => ({
        name: b.name.trim(),
        location: b.location.trim() || undefined,
        storage_class: b.storage_class,
        versioning: b.versioning,
        force_destroy: b.force_destroy,
        access: b.access,
      }))
      .filter((b) => b.name);
    if (storageBuckets.length) base.storage_buckets = storageBuckets;

    const pubsubTopics = form.pubsub_topics
      .map((t) => ({ name: t.name.trim(), create_subscription: t.create_subscription, role: t.role }))
      .filter((t) => t.name);
    if (pubsubTopics.length) base.pubsub_topics = pubsubTopics;

    const bigqueryDatasets = form.bigquery_datasets
      .map((d) => ({ name: d.name.trim(), location: d.location.trim() || undefined, access: d.access }))
      .filter((d) => d.name);
    if (bigqueryDatasets.length) base.bigquery_datasets = bigqueryDatasets;

    const cloudSqlInstances = form.cloud_sql_instances
      .map((d) => ({
        name: d.name.trim(),
        engine: d.engine,
        tier: d.tier.trim() || undefined,
        db_name: d.db_name.trim() || undefined,
        db_user: d.db_user.trim() || undefined,
        connectivity: d.connectivity,
      }))
      .filter((d) => d.name);
    if (cloudSqlInstances.length) base.cloud_sql_instances = cloudSqlInstances;

    if (form.rdi && form.rdi.name.trim()) {
      const r = form.rdi;
      const rdi: Record<string, unknown> = {
        name: r.name.trim(),
        machine_type: r.machine_type.trim() || "n2-standard-4",
      };
      if (r.target.trim()) rdi.target = r.target.trim();
      const pipelines = r.pipelines
        .filter((p) => p.source.trim())
        .map((p) => {
          const tables = p.tables
            .filter((t) => t.table.trim())
            .map((t) => ({ table: t.table.trim(), ...(t.key_prefix.trim() ? { key_prefix: t.key_prefix.trim() } : {}) }));
          return tables.length ? { source: p.source, tables } : { source: p.source };
        });
      if (pipelines.length) rdi.pipelines = pipelines;
      base.rdi = rdi;
    }

    if (form.mode === "vm") {
      if (form.clusters.length === 0) {
        Object.assign(base, {
          redis_enabled: false,
          clusters: [],
          clustersize: 0,
          app: Number(form.app),
          app_machine_types: form.app > 0 ? form.app_machine_types.slice(0, form.app) : undefined,
          memviz_enabled: form.app > 0 ? form.memviz_enabled : false,
          app_expose_http: form.app > 0 ? form.app_expose_http : false,
          app_expose_https: form.app > 0 ? form.app_expose_https : false,
          app_disk_gib: form.app > 0 ? form.app_disk_gib.slice(0, form.app) : undefined,
          app_extra_ports:
            form.app > 0 && form.app_extra_ports.trim() ? form.app_extra_ports.trim() : undefined,
          dns_managed_zone: form.dns_managed_zone,
          dns_zone_dns_name: form.dns_zone_dns_name,
        });
        const loadBalancers = form.load_balancers
          .map((lb) => ({
            name: lb.name.trim(),
            target: lb.target_kind === "vms" ? "app" : lb.target,
            target_kind: lb.target_kind,
            ports: parsePorts(lb.ports),
          }))
          .filter((lb) => lb.ports.length && lb.target)
          .map((lb) => ({ ...lb, name: lb.name || `${lb.target}-lb` }));
        if (loadBalancers.length) base.load_balancers = loadBalancers;
      } else {
      const clusters = form.clusters;
      const first = clusters[0] || blankCluster(form.machine_type);
      Object.assign(base, {
        clustersize: Number(first.nodes),
        machine_type: first.machine_type,
        rof_nvme_disks: Number(first.rof_nvme_disks),
        rs_version: first.rs_version,
        clusters: clusters.map((c) => ({
          name: c.name.trim() || undefined,
          nodes: Number(c.nodes),
          machine_type: c.machine_type,
          rof_nvme_disks: Number(c.rof_nvme_disks),
          rs_version: c.rs_version,
          RS_admin: c.RS_admin.trim() || "admin@redis.io",
          license: c.license.trim() || undefined,
          ...(c.databases.length ? { databases: databasesToPayload(c.databases, Number(c.nodes)) } : {}),
        })),
        app: Number(form.app),
        app_machine_types: form.app > 0 ? form.app_machine_types.slice(0, form.app) : undefined,
        memviz_enabled: form.app > 0 ? form.memviz_enabled : false,
        app_expose_http: form.app > 0 ? form.app_expose_http : false,
        app_expose_https: form.app > 0 ? form.app_expose_https : false,
        app_disk_gib: form.app > 0 ? form.app_disk_gib.slice(0, form.app) : undefined,
        app_extra_ports:
          form.app > 0 && form.app_extra_ports.trim() ? form.app_extra_ports.trim() : undefined,
        dns_managed_zone: form.dns_managed_zone,
        dns_zone_dns_name: form.dns_zone_dns_name,
      });
      const loadBalancers = form.load_balancers
        .map((lb) => ({
          name: lb.name.trim(),
          target: lb.target_kind === "vms" ? "app" : lb.target,
          target_kind: lb.target_kind,
          ports: parsePorts(lb.ports),
        }))
        .filter((lb) => lb.ports.length && lb.target)
        .map((lb) => ({ ...lb, name: lb.name || `${lb.target}-lb` }));
      if (loadBalancers.length) base.load_balancers = loadBalancers;
      }
      if (form.app > 0) {
        const vc = {
          clusters: form.vms_connect.clusters,
          databases: form.vms_connect.databases,
          load_balancers: form.vms_connect.load_balancers,
          apps: form.vms_connect.apps,
          storage: form.vms_connect.storage,
          pubsub: form.vms_connect.pubsub,
          bigquery: form.vms_connect.bigquery,
          sql: form.vms_connect.sql,
        };
        if (
          vc.clusters.length ||
          vc.databases.length ||
          vc.load_balancers.length ||
          vc.apps.length ||
          vc.storage.length ||
          vc.pubsub.length ||
          vc.bigquery.length ||
          vc.sql.length
        )
          base.vms_connect = vc;
      }
    } else {
      Object.assign(base, {
        gke_clustersize: Number(form.gke_clustersize),
        gke_machine_type: form.gke_machine_type,
        rec_nodes: Number(form.clusters[0]?.rec_nodes || form.rec_nodes),
        operator_chart_version: form.operator_chart_version,
        clusters: form.clusters.map((c) => ({
          name: c.name.trim() || undefined,
          rec_nodes: Number(c.rec_nodes),
          nodes: Number(c.rec_nodes),
          license: c.license.trim() || undefined,
          ...(c.databases.length ? { databases: databasesToPayload(c.databases, Number(c.rec_nodes)) } : {}),
        })),
      });
    }
    return base;
  }, [form]);

  // Report the current create config up whenever the workload form changes.
  useEffect(() => {
    onConfigChange(payload());
  }, [payload, onConfigChange]);

  return (
    <div className="wizard-view">
        {step === 2 && form.mode === "vm" && (
          <div className="grid grid-2">
            <CollapsibleSection
              title="Redis clusters (optional)"
              noun={{ one: "Redis cluster", many: "Redis clusters" }}
              names={form.clusters.map((c, i) => clusterSlug(c.name) || `Redis cluster ${i + 1}`)}
              intro={
                <p className="hint" style={{ marginTop: 4 }}>
                  One VPC and DNS zone for the whole deployment. Each cluster can be a different size and
                  Redis version. Add none to deploy only application VMs; up to 3 clusters.
                </p>
              }
            >
            {form.clusters.length > 0 ? (
            <>

            {form.clusters.map((cluster, i) => (
              <div className="cluster-card" key={`redis-cluster-${i}`}>
                <div className="wiz-workload-head">
                  <h3 className="companion-title" style={{ margin: 0 }}>
                    {cluster.name.trim()
                      ? clusterSlug(cluster.name) || `Redis cluster ${i + 1}`
                      : form.clusters.length > 1
                        ? `Redis cluster ${i + 1}`
                        : "Redis cluster"}
                  </h3>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setForm((prev) => {
                        const clusters = prev.clusters.filter((_, idx) => idx !== i);
                        return {
                          ...prev,
                          clusters,
                          clustersize: clusters[0]?.nodes ?? prev.clustersize,
                          machine_type: clusters[0]?.machine_type ?? prev.machine_type,
                        };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
                <label>
                  Cluster name
                  <input
                    value={cluster.name}
                    onChange={(e) => {
                      const name = e.target.value.slice(0, 40);
                      setForm((prev) => ({
                        ...prev,
                        clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, name } : c)),
                      }));
                      setPreflightResult(null);
                    }}
                    placeholder={form.clusters.length > 1 ? i === 0 ? "cache" : "search" : "optional — cache"}
                    required={form.clusters.length > 1}
                  />
                  <span className="hint">
                    DNS and VMs: {previewClusterPrefix(form.name, form.env, cluster.name, i)}
                    {form.clusters.length > 1 ? " · required, unique" : " · optional"}
                  </span>
                </label>
                {form.mode === "vm" ? (
                  <label>
                    Redis Enterprise admin
                    <input
                      value={cluster.RS_admin}
                      onChange={(e) => {
                        const RS_admin = e.target.value;
                        setForm((prev) => ({
                          ...prev,
                          clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, RS_admin } : c)),
                        }));
                        setPreflightResult(null);
                      }}
                      placeholder="admin@redis.io"
                    />
                  </label>
                ) : null}
                <label>
                  Cluster nodes
                  <select
                    value={cluster.nodes}
                    onChange={(e) => {
                      const nodes = Number(e.target.value);
                      setForm((prev) => {
                        const clusters = prev.clusters.map((c, idx) => {
                          if (idx !== i) return c;
                          const databases = canEnableDbReplication(nodes)
                            ? c.databases
                            : c.databases.map((d) => ({ ...d, replication: false }));
                          return { ...c, nodes, databases };
                        });
                        return {
                          ...prev,
                          clusters,
                          clustersize: clusters[0].nodes,
                        };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    <option value={1}>1 — single node (testing)</option>
                    <option value={3}>3 — HA, rack aware</option>
                    <option value={5}>5 — HA, larger</option>
                    <option value={7}>7 — HA, largest</option>
                  </select>
                </label>
                <MachineTypePicker
                  label="Redis node machine type"
                  value={cluster.machine_type}
                  onChange={(v) => {
                    setForm((prev) => {
                      const clusters = prev.clusters.map((c, idx) =>
                        idx === i ? { ...c, machine_type: v } : c,
                      );
                      return {
                        ...prev,
                        clusters,
                        machine_type: clusters[0].machine_type,
                      };
                    });
                    setPreflightResult(null);
                  }}
                  machineTypes={machineTypes}
                  loading={loading.machines}
                  showNvmeHint
                  preferredFamilies={["e2", "n2", "n2d"]}
                  hint={`Types available in ${probeZone || "selected zone"}`}
                />
                <label>
                  Redis Enterprise version
                  <select
                    value={cluster.rs_version}
                    onChange={(e) => {
                      const rs_version = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, rs_version } : c)),
                      }));
                      setPreflightResult(null);
                    }}
                  >
                    {(vmReleases.length ? vmReleases : [{ id: DEFAULT_RS_VERSION, label: DEFAULT_RS_VERSION, url: "" }]).map(
                      (r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Local NVMe disks per node
                  <select
                    value={cluster.rof_nvme_disks}
                    onChange={(e) => {
                      const rof_nvme_disks = Number(e.target.value);
                      setForm((prev) => {
                        const clusters = prev.clusters.map((c, idx) =>
                          idx === i ? { ...c, rof_nvme_disks } : c,
                        );
                        return { ...prev, clusters, rof_nvme_disks: clusters[0].rof_nvme_disks };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    <option value={0}>0 — RAM only (default)</option>
                    {[1, 2, 4, 8].map((n) => {
                      const max =
                        machineTypes.find((m) => m.name === cluster.machine_type)?.maxLocalSsds ?? 24;
                      return (
                        <option key={n} value={n} disabled={n > max}>
                          {n} × {LOCAL_SSD_GIB} GiB Local SSD{n > max ? " (not supported)" : ""}
                        </option>
                      );
                    })}
                  </select>
                  <span className="hint">
                    {cluster.rof_nvme_disks > 0
                      ? `Redis on Flash · ~${cluster.nodes * cluster.rof_nvme_disks * LOCAL_SSD_GIB} GiB flash on this cluster`
                      : "Optional Local SSD NVMe for Redis on Flash"}
                  </span>
                </label>
                <label>
                  License key (optional)
                  <textarea
                    value={cluster.license}
                    onChange={(e) => {
                      const license = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, license } : c)),
                      }));
                      setPreflightResult(null);
                    }}
                    rows={4}
                    placeholder="optional"
                  />
                  <span className="hint">Leave blank to use the 4-shard trial license.</span>
                </label>
                <DatabaseEditor
                  databases={cluster.databases}
                  license={cluster.license}
                  clusterHasNvme={cluster.rof_nvme_disks > 0}
                  clusterNodes={cluster.nodes}
                  onChange={(databases) => {
                    setForm((prev) => ({
                      ...prev,
                      clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, databases } : c)),
                    }));
                    setPreflightResult(null);
                  }}
                />
              </div>
            ))}

            </>
            ) : (
              <p className="hint" style={{ gridColumn: "1 / -1" }}>
                No Redis clusters yet — add one below, or add companion App VMs / a custom application to
                deploy without Redis Enterprise nodes.
              </p>
            )}

            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                className="btn"
                disabled={form.clusters.length >= 3}
                onClick={() => {
                  setForm((prev) => {
                    const clusters = [
                      ...prev.clusters,
                      blankCluster(prev.clusters[0]?.machine_type || prev.machine_type),
                    ];
                    return {
                      ...prev,
                      clusters,
                      clustersize: clusters[0]?.nodes ?? prev.clustersize,
                      machine_type: clusters[0]?.machine_type ?? prev.machine_type,
                    };
                  });
                  setPreflightResult(null);
                }}
              >
                Add Redis cluster
              </button>
            </div>
            </CollapsibleSection>

            <div className="companion-block">
              <h3 className="companion-title">
                {form.clusters.length > 0 ? "Companion App VMs (optional)" : "Application VMs"}
              </h3>
              <p className="hint" style={{ marginTop: 0 }}>
                Extra Compute Engine VMs on the same VPC and DNS zone for clients, memtier, or demos.
                Leave at None if you only need the Redis cluster.
              </p>
              <div className="grid grid-2">
                <label>
                  Number of App VMs
                  <select
                    value={form.app}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setForm((prev) => {
                        const fallback =
                          prev.app_machine_types.find(Boolean) ||
                          machineTypes.find((m) => m.name === "n2-standard-8")?.name ||
                          machineTypes.find((m) => m.name === "e2-standard-4")?.name ||
                          machineTypes[0]?.name ||
                          "";
                        const types = Array.from({ length: next }, (_, i) => prev.app_machine_types[i] || fallback);
                        const disks = Array.from({ length: next }, (_, i) => prev.app_disk_gib[i] || 0);
                        return {
                          ...prev,
                          app: next,
                          app_machine_types: types,
                          app_disk_gib: disks,
                          memviz_enabled: next > 0 ? prev.memviz_enabled : false,
                          app_expose_http: next > 0 ? prev.app_expose_http : false,
                          app_expose_https: next > 0 ? prev.app_expose_https : false,
                          app_extra_ports: next > 0 ? prev.app_extra_ports : "",
                        };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    <option value={0}>None — Redis only</option>
                    <option value={1}>1 App VM</option>
                    <option value={2}>2 App VMs</option>
                    <option value={3}>3 App VMs</option>
                    <option value={5}>5 App VMs</option>
                  </select>
                  <span className="hint">Each App VM can use a different machine size</span>
                </label>

                {form.app > 0 ? (
                  <label>
                    Memviz on first App VM
                    <select
                      value={form.memviz_enabled ? "yes" : "no"}
                      onChange={(e) => update("memviz_enabled", e.target.value === "yes")}
                    >
                      <option value="no">Disabled</option>
                      <option value="yes">Enabled</option>
                    </select>
                  </label>
                ) : (
                  <div />
                )}

                {form.app > 0 ? (
                  <>
                    <label>
                      Expose HTTP (port 80)
                      <select
                        value={form.app_expose_http ? "yes" : "no"}
                        onChange={(e) => update("app_expose_http", e.target.value === "yes")}
                      >
                        <option value="no">No — blocked</option>
                        <option value="yes">Yes — open from internet</option>
                      </select>
                      <span className="hint">Firewall for websites / reverse proxies on :80</span>
                    </label>
                    <label>
                      Expose HTTPS (port 443)
                      <select
                        value={form.app_expose_https ? "yes" : "no"}
                        onChange={(e) => update("app_expose_https", e.target.value === "yes")}
                      >
                        <option value="no">No — blocked</option>
                        <option value="yes">Yes — open from internet</option>
                      </select>
                      <span className="hint">Firewall for TLS sites on :443 (you still need a cert on the VM)</span>
                    </label>
                  </>
                ) : null}

                {form.app > 0 ? (
                  <div style={{ gridColumn: "1 / -1" }} className="app-vm-sizes">
                    <p className="hint" style={{ margin: "4px 0 8px" }}>
                      Size each App VM independently — pick a larger type for memtier / demos and
                      attach extra disk if the app needs space beyond the 30 GiB boot disk.
                    </p>
                    {Array.from({ length: form.app }, (_, i) => (
                      <div className="app-vm-card" key={`app-vm-${i}`}>
                        <MachineTypePicker
                          label={
                            i === 0
                              ? `App VM 1 machine type${form.memviz_enabled ? " (Memviz host)" : ""}`
                              : `App VM ${i + 1} machine type`
                          }
                          value={form.app_machine_types[i] || ""}
                          onChange={(v) => {
                            setForm((prev) => {
                              const next = [...prev.app_machine_types];
                              while (next.length < prev.app) next.push("");
                              next[i] = v;
                              return { ...prev, app_machine_types: next.slice(0, prev.app) };
                            });
                            setPreflightResult(null);
                          }}
                          machineTypes={machineTypes}
                          loading={loading.machines}
                          preferredFamilies={["n2", "e2", "n2d"]}
                          hint={
                            i === 0
                              ? "Often the largest of the set if you run memtier or Memviz here"
                              : "Can be smaller than App VM 1 to save cost"
                          }
                        />
                        <label>
                          Additional storage
                          <select
                            value={form.app_disk_gib[i] || 0}
                            onChange={(e) => {
                              const gib = Number(e.target.value);
                              setForm((prev) => {
                                const next = [...prev.app_disk_gib];
                                while (next.length < prev.app) next.push(0);
                                next[i] = gib;
                                return { ...prev, app_disk_gib: next.slice(0, prev.app) };
                              });
                              setPreflightResult(null);
                            }}
                          >
                            {APP_DISK_GIB_OPTIONS.map((gib) => (
                              <option key={gib} value={gib}>
                                {gib === 0
                                  ? "None — 30 GiB boot disk only"
                                  : `${gib} GiB extra disk, mounted at /data`}
                              </option>
                            ))}
                          </select>
                          <span className="hint">
                            Persistent pd-balanced disk, formatted ext4 and mounted at{" "}
                            <code className="mono">/data</code>
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                ) : null}

                {form.app > 0 ? (
                  <details className="app-advanced">
                    <summary>Advanced: extra TCP ports</summary>
                    <label>
                      Additional TCP ports to open
                      <input
                        type="text"
                        value={form.app_extra_ports}
                        placeholder="8080, 9090, 3000-3002"
                        onChange={(e) => update("app_extra_ports", e.target.value)}
                      />
                      <span className="hint">
                        Comma-separated ports or ranges, opened from the internet on every App VM.
                        SSH :22 is always open. Use the HTTP/HTTPS toggles for 80 and 443.
                      </span>
                      {!extraPortsLooksValid(form.app_extra_ports) ? (
                        <span className="field-error">Use numbers, commas, and ranges like 3000-3002</span>
                      ) : null}
                    </label>
                  </details>
                ) : null}
              </div>
            </div>

            <ApplicationsEditor
              applications={form.applications}
              mode="vm"
              machineTypes={machineTypes}
              loadingMachines={loading.machines}
              probeZone={probeZone}
              defaultMachineType={appDefaultMachineType}
              clusterNames={clusterConnectNames}
              databaseNames={databaseConnectNames}
              loadBalancerNames={lbConnectNames}
              appHostNames={appHostConnectNames}
              storageNames={storageConnectNames}
              pubsubNames={pubsubConnectNames}
              bigqueryNames={bigqueryConnectNames}
              cloudsqlNames={cloudsqlConnectNames}
              onUploadingChange={onUploadingChange}
              onChange={(applications) => {
                setForm((prev) => ({ ...prev, applications }));
                setPreflightResult(null);
              }}
            />

            <LoadBalancerEditor
              loadBalancers={form.load_balancers}
              appNames={appNames}
              onChange={(load_balancers) => {
                setForm((prev) => ({ ...prev, load_balancers }));
                setPreflightResult(null);
              }}
            />

            <StorageEditor
              buckets={form.storage_buckets}
              region={form.region_name}
              onChange={(storage_buckets) => {
                setForm((prev) => ({ ...prev, storage_buckets }));
                setPreflightResult(null);
              }}
            />

            <PubsubEditor
              topics={form.pubsub_topics}
              onChange={(pubsub_topics) => {
                setForm((prev) => ({ ...prev, pubsub_topics }));
                setPreflightResult(null);
              }}
            />

            <BigqueryEditor
              datasets={form.bigquery_datasets}
              region={form.region_name}
              onChange={(bigquery_datasets) => {
                setForm((prev) => ({ ...prev, bigquery_datasets }));
                setPreflightResult(null);
              }}
            />

            <CloudSqlEditor
              instances={form.cloud_sql_instances}
              region={form.region_name}
              onChange={(cloud_sql_instances) => {
                setForm((prev) => ({ ...prev, cloud_sql_instances }));
                setPreflightResult(null);
              }}
            />

            <RdiEditor
              rdi={form.rdi}
              databaseNames={databaseConnectNames}
              cloudsqlNames={cloudsqlConnectNames}
              onChange={(rdi) => {
                setForm((prev) => ({ ...prev, rdi }));
                setPreflightResult(null);
              }}
            />

            {form.app > 0 ? (
              <VmsConnectEditor
                value={form.vms_connect}
                clusterNames={clusterConnectNames}
                databaseNames={databaseConnectNames}
                loadBalancerNames={lbConnectNames}
                appHostNames={appHostConnectNames}
                storageNames={storageConnectNames}
                pubsubNames={pubsubConnectNames}
                bigqueryNames={bigqueryConnectNames}
                cloudsqlNames={cloudsqlConnectNames}
                onChange={(vms_connect) => {
                  setForm((prev) => ({ ...prev, vms_connect }));
                  setPreflightResult(null);
                }}
              />
            ) : null}
          </div>
        )}

        {step === 2 && form.mode === "gke" && (
          <div className="grid grid-2">
            <CollapsibleSection
              title="Redis Enterprise clusters"
              noun={{ one: "REC", many: "RECs" }}
              names={form.clusters.map((c, i) => clusterSlug(c.name) || `REC ${i + 1}`)}
              intro={
                <p className="hint" style={{ marginTop: 4 }}>
                  One GKE cluster and one operator. Add at least one REC to deploy; each can have a
                  different node count. The Redis version is the operator chart (in Deployment settings).
                </p>
              }
            >
            {form.clusters.map((cluster, i) => (
              <div className="cluster-card" key={`rec-${i}`}>
                <div className="wiz-workload-head">
                  <h3 className="companion-title" style={{ margin: 0 }}>
                    {cluster.name.trim()
                      ? clusterSlug(cluster.name) || `REC ${i + 1}`
                      : form.clusters.length > 1
                        ? `REC ${i + 1}`
                        : "Redis Enterprise cluster"}
                  </h3>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setForm((prev) => {
                        const clusters = prev.clusters.filter((_, idx) => idx !== i);
                        const sum = clusters.reduce((n, c) => n + c.rec_nodes, 0);
                        return {
                          ...prev,
                          clusters,
                          rec_nodes: clusters[0]?.rec_nodes ?? prev.rec_nodes,
                          gke_clustersize: Math.max(prev.gke_clustersize, sum),
                        };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
                <label>
                  Cluster name
                  <input
                    value={cluster.name}
                    onChange={(e) => {
                      const name = e.target.value.slice(0, 40);
                      setForm((prev) => ({
                        ...prev,
                        clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, name } : c)),
                      }));
                      setPreflightResult(null);
                    }}
                    placeholder={form.clusters.length > 1 ? i === 0 ? "cache" : "search" : "optional — cache"}
                    required={form.clusters.length > 1}
                  />
                  <span className="hint">
                    REC: {previewClusterPrefix(form.name, form.env, cluster.name, i)}-rec
                    {form.clusters.length > 1 ? " · required, unique" : " · optional"}
                  </span>
                </label>
                <label>
                  {form.clusters.length > 1 ? "REC nodes" : "REC nodes"}
                  <select
                    value={cluster.rec_nodes}
                    onChange={(e) => {
                      const rec_nodes = Number(e.target.value);
                      setForm((prev) => {
                        const clusters = prev.clusters.map((c, idx) => {
                          if (idx !== i) return c;
                          const databases = canEnableDbReplication(rec_nodes)
                            ? c.databases
                            : c.databases.map((d) => ({ ...d, replication: false }));
                          return { ...c, rec_nodes, nodes: rec_nodes, databases };
                        });
                        const sum = clusters.reduce((n, c) => n + c.rec_nodes, 0);
                        return {
                          ...prev,
                          clusters,
                          rec_nodes: clusters[0].rec_nodes,
                          gke_clustersize: Math.max(prev.gke_clustersize, sum),
                        };
                      });
                      setPreflightResult(null);
                    }}
                  >
                    <option value={1}>1 — testing only</option>
                    <option value={3}>3 — HA</option>
                    <option value={5}>5 — HA, larger</option>
                  </select>
                </label>
                <label>
                  License key (optional)
                  <textarea
                    value={cluster.license}
                    onChange={(e) => {
                      const license = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, license } : c)),
                      }));
                      setPreflightResult(null);
                    }}
                    rows={4}
                    placeholder="optional"
                  />
                  <span className="hint">Leave blank to use the 4-shard trial license.</span>
                </label>
                <DatabaseEditor
                  databases={cluster.databases}
                  license={cluster.license}
                  clusterHasNvme={cluster.rof_nvme_disks > 0}
                  clusterNodes={cluster.rec_nodes}
                  onChange={(databases) => {
                    setForm((prev) => ({
                      ...prev,
                      clusters: prev.clusters.map((c, idx) => (idx === i ? { ...c, databases } : c)),
                    }));
                    setPreflightResult(null);
                  }}
                />
              </div>
            ))}

            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                className="btn"
                disabled={form.clusters.length >= 3}
                onClick={() => {
                  setForm((prev) => {
                    const clusters = [...prev.clusters, blankCluster(prev.gke_machine_type)];
                    const sum = clusters.reduce((n, c) => n + c.rec_nodes, 0);
                    return {
                      ...prev,
                      clusters,
                      rec_nodes: clusters[0]?.rec_nodes ?? prev.rec_nodes,
                      gke_clustersize: Math.max(prev.gke_clustersize, sum),
                    };
                  });
                  setPreflightResult(null);
                }}
              >
                Add REC cluster
              </button>
            </div>
            </CollapsibleSection>

            <label>
              GKE nodes
              <select
                value={form.gke_clustersize}
                onChange={(e) => update("gke_clustersize", Number(e.target.value))}
              >
                {[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} node{n > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
              <span className="hint">
                Needs at least as many GKE nodes as the largest REC (anti-affinity).{" "}
                {form.clusters.reduce((n, c) => n + c.rec_nodes, 0)} REC pods planned.
              </span>
            </label>

            <div style={{ gridColumn: "1 / -1" }}>
              <MachineTypePicker
                label="GKE node machine type"
                value={form.gke_machine_type}
                onChange={(v) => update("gke_machine_type", v)}
                machineTypes={machineTypes}
                loading={loading.machines}
                preferredFamilies={["e2", "n2", "n2d"]}
                hint="e2-standard-8 or larger is recommended for REC pods"
              />
            </div>

            <ApplicationsEditor
              applications={form.applications}
              mode="gke"
              machineTypes={machineTypes}
              loadingMachines={loading.machines}
              probeZone={probeZone}
              defaultMachineType={appDefaultMachineType}
              clusterNames={clusterConnectNames}
              databaseNames={databaseConnectNames}
              appHostNames={appHostConnectNames}
              storageNames={storageConnectNames}
              pubsubNames={pubsubConnectNames}
              bigqueryNames={bigqueryConnectNames}
              cloudsqlNames={cloudsqlConnectNames}
              onUploadingChange={onUploadingChange}
              onChange={(applications) => {
                setForm((prev) => ({ ...prev, applications }));
                setPreflightResult(null);
              }}
            />

            <StorageEditor
              buckets={form.storage_buckets}
              region={form.region_name}
              onChange={(storage_buckets) => {
                setForm((prev) => ({ ...prev, storage_buckets }));
                setPreflightResult(null);
              }}
            />

            <PubsubEditor
              topics={form.pubsub_topics}
              onChange={(pubsub_topics) => {
                setForm((prev) => ({ ...prev, pubsub_topics }));
                setPreflightResult(null);
              }}
            />

            <BigqueryEditor
              datasets={form.bigquery_datasets}
              region={form.region_name}
              onChange={(bigquery_datasets) => {
                setForm((prev) => ({ ...prev, bigquery_datasets }));
                setPreflightResult(null);
              }}
            />

            <CloudSqlEditor
              instances={form.cloud_sql_instances}
              region={form.region_name}
              onChange={(cloud_sql_instances) => {
                setForm((prev) => ({ ...prev, cloud_sql_instances }));
                setPreflightResult(null);
              }}
            />

            <RdiEditor
              rdi={form.rdi}
              databaseNames={databaseConnectNames}
              cloudsqlNames={cloudsqlConnectNames}
              onChange={(rdi) => {
                setForm((prev) => ({ ...prev, rdi }));
                setPreflightResult(null);
              }}
            />
          </div>
        )}

    </div>
  );
}
