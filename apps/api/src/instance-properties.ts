import { buildAccessView } from "./access.js";
import type { DatabaseState } from "./types.js";

type Rec = Record<string, unknown>;

/** The slice of a (decorated) instance record the properties file is built from. */
export interface PropertiesSource {
  id: string;
  name: string;
  mode: "vm" | "gke";
  status: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  region: string;
  ownerEmail: string;
  folder?: string;
  config?: Record<string, unknown>;
  endpoints?: Record<string, unknown>;
  databaseStates?: DatabaseState[];
}

function list(v: unknown): Rec[] {
  return Array.isArray(v) ? (v as Rec[]) : [];
}

/**
 * Escape a value for a Java-style `.properties` file: backslash, control
 * characters and non-ASCII are written as escapes (\uXXXX per UTF-16 unit, so the
 * file is plain ASCII and loads under any charset), and a leading space is
 * escaped so it survives the loader's whitespace trimming.
 */
export function escapePropertyValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out.startsWith(" ") ? `\\${out}` : out;
}

/** A key segment: letters, digits, `_` and `-` only, so keys never need escaping. */
function seg(raw: unknown): string {
  return (
    String(raw ?? "")
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed"
  );
}

function splitEndpoint(endpoint: string): { host: string; port: string } {
  const i = endpoint.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(endpoint.slice(i + 1))) {
    return { host: endpoint.slice(0, i), port: endpoint.slice(i + 1) };
  }
  return { host: endpoint, port: "" };
}

function hostFromUrl(u: string): string {
  try {
    return u ? new URL(u).hostname : "";
  } catch {
    return "";
  }
}

type LoadBalancerRow = { name: string; vip: string; ports: string; kind: string };

/**
 * Provisioned load balancers as the instance page lists them: GKE LoadBalancer
 * Services (REC UI + app Services), the app VMs' public ports (VM mode) and the
 * internal LB VIPs Terraform provisions.
 */
function deriveLoadBalancers(inst: PropertiesSource): LoadBalancerRow[] {
  const rows: LoadBalancerRow[] = [];
  const ep = inst.endpoints;

  list(ep?.gke_app_services).forEach((s) => {
    const vip = String(s.service_ip || "");
    if (vip) {
      rows.push({
        name: String(s.name || "app"),
        vip,
        ports: Array.isArray(s.ports) ? (s.ports as unknown[]).join(", ") : "",
        kind: "GKE service",
      });
    }
  });

  const recRows = list(ep?.recs);
  (recRows.length
    ? recRows.map((r) => ({ name: String(r.name || "REC"), ui: String(r.ui || r.rec_ui_url || "") }))
    : [{ name: "REC", ui: String(ep?.rec_ui_url || "") }]
  ).forEach((r) => {
    const host = hostFromUrl(r.ui);
    if (host) rows.push({ name: `${r.name} UI`, vip: host, ports: "8443", kind: "REC UI" });
  });

  if (inst.mode === "vm") {
    const cfg = (inst.config || {}) as Rec;
    const extra = Array.isArray(cfg.app_extra_ports)
      ? (cfg.app_extra_ports as unknown[]).map(String)
      : typeof cfg.app_extra_ports === "string" && cfg.app_extra_ports.trim()
        ? cfg.app_extra_ports.trim().split(/[\s,;]+/)
        : [];
    const ports = [
      cfg.app_expose_http ? "80" : null,
      cfg.app_expose_https ? "443" : null,
      ...extra,
    ].filter(Boolean) as string[];
    const ips = Array.isArray(ep?.app_ips) ? (ep!.app_ips as unknown[]).map(String) : [];
    const dns = Array.isArray(ep?.app_dns) ? (ep!.app_dns as unknown[]).map(String) : [];
    if (ports.length && (ips.length || dns.length)) {
      rows.push({
        name: "App VMs",
        vip: dns[0] || ips[0] || "",
        ports: ports.join(", "),
        kind: "app VM ports",
      });
    }
  }

  list(ep?.load_balancers).forEach((lb) => {
    const vip = String(lb.vip || "");
    if (vip) {
      rows.push({
        name: String(lb.name || "internal-lb"),
        vip,
        ports: Array.isArray(lb.ports) ? (lb.ports as unknown[]).join(", ") : "",
        kind: "internal LB",
      });
    }
  });

  return rows;
}

/**
 * The instance's endpoints, credentials and details as a `.properties` file
 * (`name=value`, one per line, `#` comments). Mirrors the web "Endpoints &
 * credentials" panel, so it contains the tool-generated cluster admin
 * credentials the panel already shows. User-chosen database passwords are
 * deliberately NOT written (the tool never writes those to files).
 */
export function buildInstanceProperties(inst: PropertiesSource, now: Date = new Date()): string {
  const out: string[] = [
    "# Redis Enterprise Wizard - instance connection details",
    `# Instance: ${inst.id}`,
    `# Generated: ${now.toISOString()}`,
    "# WARNING: contains credentials (cluster admin password). Store it securely and do not commit it.",
    "# User-chosen database passwords are not included.",
  ];
  const used = new Set<string>();
  /** A unique `<prefix>.<name>` key stem (suffixing -2, -3 on collisions). */
  const stem = (prefix: string, name: unknown): string => {
    const base = `${prefix}.${seg(name)}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    return key;
  };

  /** Run `fill` against a collector and emit a titled section only if it wrote anything. */
  const group = (title: string, fill: (put: (key: string, value: unknown) => void) => void): void => {
    const lines: string[] = [];
    fill((key, value) => {
      const s = value == null ? "" : String(value);
      if (s) lines.push(`${key}=${escapePropertyValue(s)}`);
    });
    if (lines.length) out.push("", `# ${title}`, ...lines);
  };

  const ep = inst.endpoints || {};
  const cfg = (inst.config || {}) as Rec;

  group("Instance", (put) => {
    put("instance.id", inst.id);
    put("instance.name", inst.name);
    put("instance.mode", inst.mode);
    put("instance.status", inst.status);
    put("instance.project", inst.project);
    put("instance.region", inst.region);
    put("instance.owner", inst.ownerEmail);
    put("instance.folder", inst.folder);
    put("instance.created", inst.createdAt);
    put("instance.updated", inst.updatedAt);
  });

  const access = buildAccessView(ep, {
    mode: inst.mode,
    region: inst.region,
    region_zones: Array.isArray(cfg.region_zones) ? (cfg.region_zones as string[]) : undefined,
    machine_type: typeof cfg.machine_type === "string" ? cfg.machine_type : undefined,
  });

  if (access.kubectl) group("Kubernetes", (put) => put("kubectl.command", access.kubectl));

  access.clusters.forEach((c, i) => {
    const k = stem("cluster", c.id || c.label || `cluster-${i + 1}`);
    group(`Redis cluster: ${c.label || c.id}`, (put) => {
      put(`${k}.label`, c.label);
      put(`${k}.machine_type`, c.machineType);
      put(`${k}.node_count`, c.nodeCount);
      put(`${k}.dns`, c.clusterDns);
      put(`${k}.ui.url`, c.uiUrl);
      put(`${k}.ui.ip_url`, c.uiIpUrl);
      put(`${k}.admin.username`, c.adminUsername);
      put(`${k}.admin.password`, c.adminPassword);
      c.nodes.forEach((n, j) => {
        const nk = `${k}.node.${j + 1}`;
        put(`${nk}.name`, n.name);
        put(`${nk}.dns`, n.dns);
        put(`${nk}.ip`, n.ip);
        put(`${nk}.zone`, n.zone);
        put(`${nk}.machine_type`, n.machineType);
        put(`${nk}.ssh`, n.ssh);
      });
    });
  });

  // buildAccessView falls back to app_workloads when there are no companion App
  // VMs, which would just repeat the "workload.*" block below; skip that case.
  const appVmsAreWorkloads = list(ep.app_workloads).length > 0 && list(ep.apps).length === 0;
  (appVmsAreWorkloads ? [] : access.apps).forEach((a, i) => {
    const k = stem("appvm", a.id || a.name || `app-${i + 1}`);
    group(`App VM: ${a.label || a.name}`, (put) => {
      put(`${k}.name`, a.name);
      put(`${k}.dns`, a.dns);
      put(`${k}.ip`, a.ip);
      put(`${k}.zone`, a.zone);
      put(`${k}.machine_type`, a.machineType);
      put(`${k}.ssh`, a.ssh);
      put(`${k}.http_url`, a.httpUrl);
      put(`${k}.https_url`, a.httpsUrl);
    });
  });

  (inst.databaseStates || []).forEach((d) => {
    const k = stem("database", `${d.cluster}-${d.name}`);
    const { host, port } = splitEndpoint(d.endpoint || "");
    group(`Database: ${d.cluster} / ${d.name}`, (put) => {
      put(`${k}.cluster`, d.cluster);
      put(`${k}.name`, d.name);
      put(`${k}.status`, d.status);
      put(`${k}.endpoint`, d.endpoint);
      put(`${k}.host`, host);
      put(`${k}.port`, port || d.port);
    });
  });

  list(ep.app_workloads).forEach((w, i) => {
    const k = stem("workload", w.name || w.app_name || `app-${i + 1}`);
    group(`Application workload: ${String(w.app_name || w.name || i + 1)}`, (put) => {
      put(`${k}.app`, w.app_name);
      put(`${k}.name`, w.name);
      put(`${k}.ip`, w.ip);
      put(`${k}.dns`, w.dns);
      put(`${k}.zone`, w.zone);
      put(`${k}.ports`, Array.isArray(w.ports) ? (w.ports as unknown[]).join(",") : "");
      put(`${k}.ssh`, w.how_to_ssh);
    });
  });

  list(ep.gke_app_services).forEach((s, i) => {
    const k = stem("gke_service", s.name || `app-${i + 1}`);
    group(`GKE application: ${String(s.name || i + 1)}`, (put) => {
      put(`${k}.name`, s.name);
      put(`${k}.ip`, s.service_ip);
      put(`${k}.ports`, Array.isArray(s.ports) ? (s.ports as unknown[]).join(",") : "");
    });
  });

  deriveLoadBalancers(inst).forEach((lb) => {
    const k = stem("loadbalancer", lb.name);
    group(`Load balancer: ${lb.name}`, (put) => {
      put(`${k}.kind`, lb.kind);
      put(`${k}.vip`, lb.vip);
      put(`${k}.ports`, lb.ports);
    });
  });

  list(ep.storage_buckets).forEach((b) => {
    const name = String(b.name || "");
    const k = stem("bucket", name);
    group(`Storage bucket: ${name}`, (put) => {
      put(`${k}.name`, name);
      put(`${k}.url`, b.url || (name ? `gs://${name}` : ""));
      put(`${k}.location`, b.location);
    });
  });

  list(ep.pubsub_topics).forEach((t) => {
    const k = stem("pubsub", t.name || t.topic);
    group(`Pub/Sub: ${String(t.name || t.topic || "")}`, (put) => {
      put(`${k}.topic`, t.topic || t.name);
      put(`${k}.subscription`, t.subscription);
    });
  });

  list(ep.bigquery_datasets).forEach((d) => {
    const k = stem("bigquery", d.name);
    group(`BigQuery: ${String(d.name || "")}`, (put) => {
      put(`${k}.dataset`, d.name);
      put(`${k}.location`, d.location);
    });
  });

  list(ep.cloud_sql_instances).forEach((d) => {
    const k = stem("cloudsql", d.name);
    group(`Cloud SQL: ${String(d.name || "")}`, (put) => {
      put(`${k}.name`, d.name);
      put(`${k}.connection_name`, d.connection_name);
      put(`${k}.connectivity`, d.connectivity);
      put(`${k}.location`, d.location);
    });
  });

  const rdi = ep.rdi && typeof ep.rdi === "object" ? (ep.rdi as Rec) : null;
  if (rdi && rdi.name) {
    group("Redis Data Integration", (put) => {
      put("rdi.name", rdi.name);
      put("rdi.namespace", rdi.namespace);
      put("rdi.dns", rdi.dns);
      put("rdi.ip", rdi.ip);
    });
  }

  return `${out.join("\n")}\n`;
}
