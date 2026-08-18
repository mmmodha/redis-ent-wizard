"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckList } from "@/components/CheckList";
import { MachineTypePicker } from "@/components/MachineTypePicker";
import Link from "next/link";
import {
  createInstance,
  listCredentials,
  listDnsZones,
  listFolders,
  listMachineTypes,
  listProjects,
  listRegions,
  runPreflight,
  listReleases,
  type Credential,
  type DnsZoneInfo,
  type GkeOperatorInfo,
  type MachineTypeInfo,
  type PreflightResult,
  type ProjectInfo,
  type RegionInfo,
  type RsReleaseInfo,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Mode = "vm" | "gke";

const steps = ["Credentials", "Target", "Sizing", "Validate"];
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
};

function blankCluster(machine = ""): ClusterDraft {
  return {
    name: "",
    nodes: 3,
    machine_type: machine,
    rof_nvme_disks: 0,
    rs_version: DEFAULT_RS_VERSION,
    rec_nodes: 3,
  };
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

export default function WizardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [machineTypes, setMachineTypes] = useState<MachineTypeInfo[]>([]);
  const [dnsZones, setDnsZones] = useState<DnsZoneInfo[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [lookupError, setLookupError] = useState("");

  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);

  const [existingFolders, setExistingFolders] = useState<string[]>([]);
  const [vmReleases, setVmReleases] = useState<RsReleaseInfo[]>([]);
  const [gkeReleases, setGkeReleases] = useState<GkeOperatorInfo[]>([]);

  const [form, setForm] = useState({
    name: "",
    youremail: "",
    project: "",
    credentialsFile: "",
    region_name: "",
    env: "default",
    folder: "",
    mode: "vm" as Mode,
    region_zones: ["b", "c", "d"] as string[],
    clustersize: 3,
    machine_type: "",
    rof_nvme_disks: 0,
    clusters: [blankCluster()] as ClusterDraft[],
    RS_admin: "admin@redis.io",
    app: 0,
    app_machine_types: [] as string[],
    memviz_enabled: false,
    app_expose_http: false,
    app_expose_https: false,
    app_disk_gib: [] as number[],
    app_extra_ports: "",
    gke_clustersize: 3,
    gke_machine_type: "",
    rec_nodes: 3,
    operator_chart_version: "latest",
    dns_managed_zone: "",
    dns_zone_dns_name: "",
  });

  useEffect(() => {
    if (user?.email) {
      setForm((prev) => (prev.youremail ? prev : { ...prev, youremail: user.email }));
    }
  }, [user?.email]);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setPreflightResult(null);
  }

  const selectedRegion = useMemo(
    () => regions.find((r) => r.name === form.region_name),
    [regions, form.region_name],
  );

  const probeZone = useMemo(() => {
    if (!form.region_name) return "";
    const suffix = form.region_zones[0] || selectedRegion?.zoneSuffixes[0] || "b";
    return `${form.region_name}-${suffix}`;
  }, [form.region_name, form.region_zones, selectedRegion]);

  useEffect(() => {
    listCredentials()
      .then(setCredentials)
      .catch((err) => setLookupError(err instanceof Error ? err.message : "Failed to list credentials"));
    listFolders()
      .then((list) => setExistingFolders(list.map((f) => f.folder).filter(Boolean)))
      .catch(() => setExistingFolders([]));
    listReleases()
      .then((r) => {
        setVmReleases(r.vm);
        setGkeReleases(r.gke);
      })
      .catch(() => {
        setVmReleases([{ id: DEFAULT_RS_VERSION, label: "8.2.0-46 (default)", url: "" }]);
        setGkeReleases([{ id: "latest", label: "Latest operator chart", chartVersion: "" }]);
      });
  }, []);

  // Credentials -> projects
  useEffect(() => {
    if (!form.credentialsFile) {
      setProjects([]);
      return;
    }
    setLoading((l) => ({ ...l, projects: true }));
    setLookupError("");
    listProjects(form.credentialsFile)
      .then((list) => {
        setProjects(list);
        const cred = credentials.find((c) => c.file === form.credentialsFile);
        const preferred = cred?.projectId && list.some((p) => p.projectId === cred.projectId)
          ? cred.projectId
          : list[0]?.projectId || "";
        setForm((prev) => ({ ...prev, project: prev.project || preferred }));
      })
      .catch((err) => setLookupError(err instanceof Error ? err.message : "Failed to list projects"))
      .finally(() => setLoading((l) => ({ ...l, projects: false })));
  }, [form.credentialsFile, credentials]);

  // Project -> regions + DNS zones
  useEffect(() => {
    if (!form.credentialsFile || !form.project) {
      setRegions([]);
      setDnsZones([]);
      return;
    }
    setLoading((l) => ({ ...l, regions: true }));
    listRegions(form.credentialsFile, form.project)
      .then((list) => {
        setRegions(list);
        setForm((prev) => ({
          ...prev,
          region_name:
            prev.region_name && list.some((r) => r.name === prev.region_name)
              ? prev.region_name
              : list.some((r) => r.name === "europe-west1")
                ? "europe-west1"
                : list[0]?.name || "",
        }));
      })
      .catch((err) => setLookupError(err instanceof Error ? err.message : "Failed to list regions"))
      .finally(() => setLoading((l) => ({ ...l, regions: false })));

    listDnsZones(form.credentialsFile, form.project)
      .then((zones) => {
        const sorted = [...zones].sort((a, b) => {
          const publicFirst = Number(b.visibility === "public") - Number(a.visibility === "public");
          return publicFirst || a.name.localeCompare(b.name);
        });
        setDnsZones(sorted);
        setForm((prev) => {
          if (prev.dns_managed_zone && sorted.some((z) => z.name === prev.dns_managed_zone)) {
            return prev;
          }
          const preferred =
            sorted.find((z) => z.name === "demo-clusters") ||
            sorted.find((z) => z.visibility === "public" && z.dnsName.endsWith("demo.redislabs.com")) ||
            sorted.find((z) => z.visibility === "public") ||
            sorted[0];
          return preferred
            ? { ...prev, dns_managed_zone: preferred.name, dns_zone_dns_name: preferred.dnsName }
            : prev;
        });
      })
      .catch(() => setDnsZones([]));
  }, [form.credentialsFile, form.project]);

  // Region zones default to what the region actually offers
  useEffect(() => {
    if (!selectedRegion) return;
    setForm((prev) => {
      const valid = prev.region_zones.filter((z) => selectedRegion.zoneSuffixes.includes(z));
      const next = valid.length ? valid : selectedRegion.zoneSuffixes.slice(0, 3);
      return next.join(",") === prev.region_zones.join(",") ? prev : { ...prev, region_zones: next };
    });
  }, [selectedRegion]);

  // Zone -> machine types
  useEffect(() => {
    if (!form.credentialsFile || !form.project || !probeZone) {
      setMachineTypes([]);
      return;
    }
    setLoading((l) => ({ ...l, machines: true }));
    listMachineTypes(form.credentialsFile, form.project, probeZone)
      .then((list) => {
        setMachineTypes(list);
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
      })
      .catch((err) =>
        setLookupError(err instanceof Error ? err.message : "Failed to list machine types"),
      )
      .finally(() => setLoading((l) => ({ ...l, machines: false })));
  }, [form.credentialsFile, form.project, probeZone]);

  const payload = useCallback(() => {
    const base: Record<string, unknown> = {
      name: form.name,
      mode: form.mode,
      youremail: form.youremail,
      project: form.project,
      credentialsFile: form.credentialsFile,
      region_name: form.region_name,
      env: form.env,
      folder: form.folder.trim() || undefined,
      region_zones: form.region_zones,
    };
    if (form.mode === "vm") {
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
        })),
        RS_admin: form.RS_admin,
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
        })),
      });
    }
    return base;
  }, [form]);

  const validCredential = credentials.find((c) => c.file === form.credentialsFile)?.valid;

  // Mirrors the API rule: an email, or a person's name if they have no email here.
  const ownerError = useMemo(() => {
    const value = form.youremail.trim();
    if (!value) return "Required — who is creating this?";
    if (value.length < 3) return "Too short";
    if (value.includes("@")) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "" : "Not a valid email address";
    }
    return /^[\p{L}][\p{L}\d._' -]+$/u.test(value) ? "" : "Use an email address or a name";
  }, [form.youremail]);

  const canContinue = useMemo(() => {
    if (step === 0) {
      return Boolean(
        form.name &&
          !ownerError &&
          form.credentialsFile &&
          validCredential &&
          form.project &&
          form.region_name,
      );
    }
    if (step === 2) {
      const slugs = form.clusters.map((c) => clusterSlug(c.name));
      const required = form.clusters.length > 1;
      if (slugs.some((slug, i) => (required || form.clusters[i].name.trim()) && (!slug || !/^[a-z]/.test(slug) || slug === "app" || slug === "gke"))) {
        return false;
      }
      const named = slugs.filter(Boolean);
      if (required && named.length !== form.clusters.length) return false;
      if (new Set(named).size !== named.length) return false;
      if (form.mode === "gke") {
        if (!form.gke_machine_type) return false;
        if (form.clusters.some((c) => !c.rec_nodes)) return false;
        return true;
      }
      if (form.clusters.some((c) => !c.machine_type)) return false;
      if (form.app > 0) {
        if (form.app_machine_types.length < form.app) return false;
        if (form.app_machine_types.slice(0, form.app).some((t) => !t)) return false;
        if (!extraPortsLooksValid(form.app_extra_ports)) return false;
      }
      return true;
    }
    return true;
  }, [step, form, validCredential, ownerError]);

  const summaryRows = useMemo(() => {
    const cred = credentials.find((c) => c.file === form.credentialsFile);
    const rows: { label: string; value: string }[] = [
      { label: "Owner", value: form.youremail + (form.folder.trim() ? ` · folder ${form.folder.trim()}` : "") },
      { label: "Credentials", value: cred?.name || cred?.file || form.credentialsFile },
      { label: "Project", value: form.project },
    ];

    if (form.mode === "vm") {
      rows.push({
        label: "Region / zones",
        value: `${form.region_name} [${form.region_zones.join(", ")}]`,
      });
      rows.push({
        label: "Redis clusters",
        value: form.clusters
          .map(
            (c, i) =>
              `${c.name.trim() ? `${clusterSlug(c.name) || c.name} ` : form.clusters.length > 1 ? `C${i + 1} ` : ""}${c.nodes} × ${c.machine_type || "?"} · ${c.rs_version}${
                c.rof_nvme_disks > 0 ? ` · ${c.rof_nvme_disks} NVMe` : ""
              }`,
          )
          .join("; "),
      });
      rows.push({
        label: "App VMs",
        value:
          form.app > 0
            ? `${form.app}: ${form.app_machine_types.slice(0, form.app).join(", ") || "not selected"}${form.memviz_enabled ? " · Memviz on #1" : ""}`
            : "None",
      });
      if (form.app > 0) {
        const disks = form.app_disk_gib.slice(0, form.app);
        const extraDisks = disks.filter((n) => n > 0);
        rows.push({
          label: "App extra disks",
          value: extraDisks.length
            ? disks
                .map((n, i) => (n > 0 ? `VM${i + 1} +${n} GiB /data` : `VM${i + 1} boot only`))
                .join("; ")
            : "None — 30 GiB boot disk only",
        });
        const ports = [
          form.app_expose_http ? "HTTP :80" : null,
          form.app_expose_https ? "HTTPS :443" : null,
          form.app_extra_ports.trim() ? `TCP ${form.app_extra_ports.trim()}` : null,
        ].filter(Boolean);
        rows.push({
          label: "App web ports",
          value: ports.length ? ports.join(" + ") + " from internet" : "Closed (SSH only)",
        });
      }
      rows.push({
        label: "DNS zone",
        value: form.dns_managed_zone
          ? `${form.dns_managed_zone} → ${form.dns_zone_dns_name}`
          : "default",
      });
      rows.push({ label: "Admin user", value: form.RS_admin });
    } else {
      rows.push({ label: "Region", value: form.region_name });
      rows.push({
        label: "GKE nodes",
        value: `${form.gke_clustersize} × ${form.gke_machine_type}`,
      });
      rows.push({
        label: "Operator",
        value:
          gkeReleases.find((r) => r.id === form.operator_chart_version)?.label ||
          form.operator_chart_version,
      });
      rows.push({
        label: "REC clusters",
        value: form.clusters
          .map((c, i) => {
            const tag = c.name.trim() ? clusterSlug(c.name) || c.name : form.clusters.length > 1 ? `C${i + 1}` : "";
            return `${tag ? `${tag} ` : ""}${c.rec_nodes} nodes`;
          })
          .join("; "),
      });
    }
    return rows;
  }, [form, credentials, gkeReleases]);

  const runChecks = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      setPreflightResult(await runPreflight(payload()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight failed");
    } finally {
      setChecking(false);
    }
  }, [payload]);

  useEffect(() => {
    if (step === 3 && !preflightResult && !checking) {
      void runChecks();
    }
  }, [step, preflightResult, checking, runChecks]);

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const created = await createInstance(payload());
      router.push(`/instances/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">Wizard</p>
          <h2 className="page-title">Create instance</h2>
          <p className="page-sub">Validated against your GCP project before anything is created</p>
        </div>
      </div>

      <div className="steps">
        {steps.map((label, idx) => (
          <div
            key={label}
            className={`step-pill ${idx === step ? "active" : ""} ${idx < step ? "done" : ""}`}
          >
            {idx + 1}. {label}
          </div>
        ))}
      </div>

      <div className="panel">
        {error ? <div className="error">{error}</div> : null}
        {lookupError ? <div className="error">{lookupError}</div> : null}

        {step === 0 && (
          <div className="grid grid-2">
            <label>
              Service account key
              <select
                value={form.credentialsFile}
                onChange={(e) => update("credentialsFile", e.target.value)}
              >
                <option value="">Select credentials…</option>
                {credentials.map((c) => (
                  <option key={c.file} value={c.file} disabled={!c.valid}>
                    {c.name || c.file}
                    {c.projectId ? ` — ${c.projectId}` : ""}
                    {c.valid ? "" : " (invalid)"}
                  </option>
                ))}
              </select>
              <span className="hint">
                {credentials.length ? (
                  <>
                    Your uploaded keys ·{" "}
                    <Link href="/credentials">Add your JSON</Link>
                  </>
                ) : (
                  <>
                    No keys yet — <Link href="/credentials">add your service account JSON</Link>
                  </>
                )}
              </span>
            </label>

            <label>
              GCP project
              <select
                value={form.project}
                onChange={(e) => update("project", e.target.value)}
                disabled={!projects.length}
              >
                {loading.projects ? <option value="">Loading projects…</option> : null}
                {!loading.projects && !projects.length ? (
                  <option value="">Select credentials first</option>
                ) : null}
                {projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name} ({p.projectId})
                  </option>
                ))}
              </select>
              <span className="hint">
                {form.credentialsFile
                  ? credentials.find((c) => c.file === form.credentialsFile)?.clientEmail
                  : "Projects visible to this service account"}
              </span>
            </label>

            <label>
              Instance name
              <input
                value={form.name}
                onChange={(e) => update("name", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="demo01"
              />
              <span className="hint">
                Resources are prefixed <code className="mono">{form.name || "name"}-{form.env}</code>
              </span>
            </label>

            <label>
              Environment tag
              <input
                value={form.env}
                onChange={(e) => update("env", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              />
            </label>

            <label>
              Folder
              <input
                list="wizard-folders"
                value={form.folder}
                onChange={(e) => update("folder", e.target.value.slice(0, 60))}
                placeholder="team-emea / customer-acme"
              />
              <datalist id="wizard-folders">
                {existingFolders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <span className="hint">Optional group for filtering and bulk destroy later</span>
            </label>

            <label>
              <span className="field-required">Created by</span>
              <input
                value={form.youremail}
                onChange={(e) => update("youremail", e.target.value)}
                placeholder="you@company.com or your name"
                aria-invalid={Boolean(ownerError)}
                required
              />
              {ownerError ? (
                <span className="field-error">{ownerError}</span>
              ) : (
                <span className="hint">
                  Email or name — used for grouping and as the owner label on GCP resources
                </span>
              )}
            </label>

            <label>
              Region
              <select
                value={form.region_name}
                onChange={(e) => update("region_name", e.target.value)}
                disabled={!regions.length}
              >
                {loading.regions ? <option value="">Loading regions…</option> : null}
                {!loading.regions && !regions.length ? (
                  <option value="">Select a project first</option>
                ) : null}
                {regions.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name} ({r.zoneSuffixes.length} zones)
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {step === 1 && (
          <div className="mode-cards">
            <button
              type="button"
              className={`mode-card ${form.mode === "vm" ? "selected" : ""}`}
              onClick={() => update("mode", "vm")}
            >
              <h3>VM deployment</h3>
              <p>
                Redis Enterprise on Compute Engine. Optionally add companion App VMs (same VPC and
                DNS zone) for clients or memtier.
              </p>
            </button>
            <button
              type="button"
              className={`mode-card ${form.mode === "gke" ? "selected" : ""}`}
              onClick={() => update("mode", "gke")}
            >
              <h3>GKE deployment</h3>
              <p>
                Provision GKE and install Redis Enterprise Operator + REC with a LoadBalancer UI
                endpoint.
              </p>
            </button>
          </div>
        )}

        {step === 2 && form.mode === "vm" && (
          <div className="grid grid-2">
            <label>
              How many Redis clusters?
              <select
                value={form.clusters.length}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setForm((prev) => {
                    const fallback = prev.clusters[0]?.machine_type || prev.machine_type;
                    const clusters = Array.from({ length: next }, (_, i) =>
                      prev.clusters[i] || { ...blankCluster(fallback), machine_type: fallback },
                    );
                    return { ...prev, clusters, clustersize: clusters[0].nodes, machine_type: clusters[0].machine_type };
                  });
                  setPreflightResult(null);
                }}
              >
                <option value={1}>1 cluster</option>
                <option value={2}>2 clusters</option>
                <option value={3}>3 clusters</option>
              </select>
              <span className="hint">
                One VPC and DNS zone for the whole deployment. Each cluster can be a different size
                and Redis version. Shared App VMs are below.
              </span>
            </label>
            <div />

            {form.clusters.map((cluster, i) => (
              <div className="cluster-card" key={`redis-cluster-${i}`}>
                <h3 className="companion-title">
                  {cluster.name.trim()
                    ? clusterSlug(cluster.name) || `Redis cluster ${i + 1}`
                    : form.clusters.length > 1
                      ? `Redis cluster ${i + 1}`
                      : "Redis cluster"}
                </h3>
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
                <label>
                  Cluster nodes
                  <select
                    value={cluster.nodes}
                    onChange={(e) => {
                      const nodes = Number(e.target.value);
                      setForm((prev) => {
                        const clusters = prev.clusters.map((c, idx) => (idx === i ? { ...c, nodes } : c));
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
              </div>
            ))}

            <label>
              Zones
              <div className="zone-picker">
                {(selectedRegion?.zoneSuffixes || []).map((z) => {
                  const active = form.region_zones.includes(z);
                  return (
                    <button
                      key={z}
                      type="button"
                      className={`chip ${active ? "chip-active" : ""}`}
                      onClick={() =>
                        update(
                          "region_zones",
                          active
                            ? form.region_zones.filter((x) => x !== z)
                            : [...form.region_zones, z].sort(),
                        )
                      }
                    >
                      {form.region_name}-{z}
                    </button>
                  );
                })}
              </div>
              <span className="hint">Nodes are spread across selected zones for rack awareness</span>
            </label>

            <label>
              Redis Enterprise admin
              <input value={form.RS_admin} onChange={(e) => update("RS_admin", e.target.value)} />
            </label>

            <label>
              DNS managed zone
              <select
                value={form.dns_managed_zone}
                onChange={(e) => {
                  const zone = dnsZones.find((z) => z.name === e.target.value);
                  setForm((prev) => ({
                    ...prev,
                    dns_managed_zone: e.target.value,
                    dns_zone_dns_name: zone?.dnsName || prev.dns_zone_dns_name,
                  }));
                  setPreflightResult(null);
                }}
                disabled={!dnsZones.length}
              >
                {dnsZones.length ? null : <option value="">No managed zones found</option>}
                {dnsZones.map((z) => (
                  <option key={z.name} value={z.name}>
                    {z.name} → {z.dnsName}
                  </option>
                ))}
              </select>
              <span className="hint">
                Shared by Redis and any App VMs — cluster DNS{" "}
                <code className="mono">
                  cluster.{form.name || "name"}-{form.env}.{form.dns_zone_dns_name || "zone"}
                </code>
                {form.app > 0 ? (
                  <>
                    {" "}
                    · app DNS{" "}
                    <code className="mono">
                      app.{form.name || "name"}-{form.env}.{form.dns_zone_dns_name || "zone"}
                    </code>
                  </>
                ) : null}
              </span>
            </label>

            <div className="companion-block">
              <h3 className="companion-title">Companion App VMs (optional)</h3>
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
          </div>
        )}

        {step === 2 && form.mode === "gke" && (
          <div className="grid grid-2">
            <label>
              How many Redis clusters?
              <select
                value={form.clusters.length}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setForm((prev) => {
                    const clusters = Array.from(
                      { length: next },
                      (_, i) => prev.clusters[i] || blankCluster(prev.gke_machine_type),
                    );
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
                <option value={1}>1 REC</option>
                <option value={2}>2 RECs</option>
                <option value={3}>3 RECs</option>
              </select>
              <span className="hint">
                One GKE cluster and one operator. Each REC can have a different node count. Redis
                version is the operator chart (shared).
              </span>
            </label>
            <label>
              Operator / Redis version
              <select
                value={form.operator_chart_version}
                onChange={(e) => update("operator_chart_version", e.target.value)}
              >
                {(gkeReleases.length
                  ? gkeReleases
                  : [{ id: "latest", label: "Latest operator chart", chartVersion: "" }]
                ).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            {form.clusters.map((cluster, i) => (
              <div className="cluster-card" key={`rec-${i}`}>
                <h3 className="companion-title">
                  {cluster.name.trim()
                    ? clusterSlug(cluster.name) || `REC ${i + 1}`
                    : form.clusters.length > 1
                      ? `REC ${i + 1}`
                      : "Redis Enterprise cluster"}
                </h3>
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
                        const clusters = prev.clusters.map((c, idx) =>
                          idx === i ? { ...c, rec_nodes, nodes: rec_nodes } : c,
                        );
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
              </div>
            ))}

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
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="review-head">
              <div>
                <h3 style={{ margin: "0 0 4px" }}>
                  {form.name}-{form.env}
                </h3>
                <p className="hint" style={{ margin: 0 }}>
                  {form.mode.toUpperCase()} · {form.project} · {form.region_name}
                </p>
              </div>
              <button className="btn" type="button" onClick={runChecks} disabled={checking}>
                {checking ? "Checking…" : "Re-run checks"}
              </button>
            </div>

            <div className="summary-grid">
              {summaryRows.map((row) => (
                <div className="summary-row" key={row.label}>
                  <div className="summary-label">{row.label}</div>
                  <div className="summary-value">{row.value}</div>
                </div>
              ))}
            </div>

            {checking && !preflightResult ? (
              <div className="empty">Validating against GCP…</div>
            ) : null}

            {preflightResult ? <CheckList checks={preflightResult.checks} /> : null}

            {preflightResult && !preflightResult.ok ? (
              <div className="error">
                Fix the failed checks above before applying. Nothing has been created yet.
              </div>
            ) : null}
          </div>
        )}

        <div className="actions">
          <button
            className="btn"
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => s - 1)}
          >
            Back
          </button>
          {step < steps.length - 1 ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={!canContinue}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={submitting || checking || !preflightResult?.ok}
              onClick={submit}
            >
              {submitting ? "Starting…" : "Apply with Terraform"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
