/** View-model for instance endpoints. Keep in sync with apps/web/lib/access.ts */

export type AccessContext = {
  mode?: "vm" | "gke";
  region?: string;
  region_zones?: string[];
  machine_type?: string;
};

export type AccessNode = {
  name: string;
  dns: string;
  ip: string;
  zone: string;
  machineType: string;
  ssh: string;
};

export type AccessCluster = {
  id: string;
  label: string;
  machineType: string;
  nodeCount: number;
  clusterDns: string;
  uiUrl: string;
  uiIpUrl: string;
  adminUsername: string;
  adminPassword: string;
  nodes: AccessNode[];
};

export type AccessAppVm = {
  id: string;
  label: string;
  name: string;
  dns: string;
  ip: string;
  machineType: string;
  zone: string;
  ssh: string;
  httpUrl: string;
  httpsUrl: string;
};

export type AccessView = {
  clusters: AccessCluster[];
  apps: AccessAppVm[];
  kubectl?: string;
};

const RE_UI_PORT = "8443";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const s = asString(value).trim();
  return s ? [s] : [];
}

function trimDot(value: string): string {
  return value.replace(/\.$/, "");
}

function zoneForIndex(region: string, suffixes: string[], index: number): string {
  if (!region || !suffixes.length) return "";
  const suffix = suffixes[index % suffixes.length];
  return suffix.includes("-") ? suffix : `${region}-${suffix}`;
}

function parseSshZone(command: string): string {
  const m = command.match(/--zone\s+(\S+)/);
  return m?.[1] || "";
}

function parseSshName(command: string): string {
  const m = command.match(/gcloud compute ssh\s+(\S+)/);
  return m?.[1] || "";
}

function sshCommand(name: string, zone: string): string {
  if (!name) return "";
  return zone ? `gcloud compute ssh ${name} --zone ${zone}` : `gcloud compute ssh ${name}`;
}

function withSshZone(command: string, name: string, zone: string): string {
  if (command && parseSshZone(command)) return command;
  if (command && zone) return `${command} --zone ${zone}`;
  return sshCommand(name, zone);
}

function dnsSuffixFromClusterDns(clusterDns: string): string {
  const host = trimDot(clusterDns.replace(/^https?:\/\//, "").replace(/:\d+$/, ""));
  return host.replace(/^cluster\./, "");
}

function nodeUiUrl(clusterDns: string): string {
  const suffix = dnsSuffixFromClusterDns(clusterDns);
  return suffix ? `https://node1.${suffix}:${RE_UI_PORT}` : "";
}

function withUiPort(raw: string): string {
  const value = trimDot(raw.trim());
  if (!value) return "";
  if (/^https?:\/\//.test(value)) {
    if (/:8443(\/|$)/.test(value)) return value;
    if (/:\d+(\/|$)/.test(value)) return value;
    return `${value}:${RE_UI_PORT}`;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `https://${value}:${RE_UI_PORT}`;
  if (value.startsWith("cluster.")) return "";
  return `https://${value.replace(/:\d+$/, "")}:${RE_UI_PORT}`;
}

function nodeNameFromPrefix(prefix: string, index: number, node1Name: string): string {
  if (index === 0 && node1Name) return node1Name;
  if (prefix) return `${prefix}-${index + 1}`;
  if (node1Name) return node1Name.replace(/-1$/, `-${index + 1}`);
  return "";
}

function vmClustersFromList(
  endpoints: Record<string, unknown>,
  ctx: AccessContext,
): AccessCluster[] {
  const listed = Array.isArray(endpoints.clusters) ? endpoints.clusters : null;
  if (!listed) {
    return vmClusterFromFlat(endpoints, ctx);
  }
  const username = asString(endpoints.admin_username);
  const fallbackZone = parseSshZone(asStringList(endpoints.how_to_ssh)[0] || "");
  const suffixes = ctx.region_zones?.length
    ? ctx.region_zones
    : fallbackZone
      ? [fallbackZone.replace(/^.*-/, "")]
      : [];
  const region = ctx.region || fallbackZone.replace(/-[a-z]$/, "");

  return listed
    .map((raw) => asRecord(raw) || {})
    .filter((c) => Number(c.nodes) > 0)
    .map((c, i) => {
    const clusterDns = trimDot(asString(c.dns || c.cluster_dns || c.rs_cluster_dns));
    const ips = asStringList(c.nodes_ip);
    const dnsList = asStringList(c.nodes_dns).map(trimDot);
    const names = asStringList(c.node_names);
    const zones = asStringList(c.node_zones);
    const sshList = asStringList(c.how_to_ssh);
    const prefix = asString(c.name_prefix);
    const node1Name = asString(c.node1_name);
    const machineType = asString(c.machine_type);
    const nodeCount = Number(c.nodes) || Math.max(ips.length, dnsList.length, names.length, 1);
    const nodes: AccessNode[] = [];
    for (let n = 0; n < nodeCount; n++) {
      const zone = zones[n] || zoneForIndex(region, suffixes, n) || fallbackZone;
      const name = names[n] || nodeNameFromPrefix(prefix, n, node1Name);
      const ssh = sshList[n] || sshCommand(name, zone);
      const suffix = dnsSuffixFromClusterDns(clusterDns);
      nodes.push({
        name,
        dns: dnsList[n] || (suffix ? `node${n + 1}.${suffix}` : ""),
        ip: ips[n] || "",
        zone,
        machineType,
        ssh,
      });
    }
    const uiIp = withUiPort(asString(c.ui) || ips[0] || "");
    return {
      id: `cluster-${i + 1}`,
      label: asString(c.name) || `Cluster ${Number(c.index) || i + 1}`,
      machineType,
      nodeCount: nodes.length,
      clusterDns,
      uiUrl: nodeUiUrl(clusterDns) || withUiPort(nodes[0]?.dns || "") || uiIp,
      uiIpUrl: uiIp,
      adminUsername: asString(c.admin_username) || username,
      adminPassword: asString(c.admin_password) || asString(endpoints.admin_password),
      nodes,
    };
  });
}

function vmClusterFromFlat(endpoints: Record<string, unknown>, ctx: AccessContext): AccessCluster[] {
  const clusterDns = trimDot(asString(endpoints.rs_cluster_dns));
  const ips = asStringList(endpoints.nodes_ip);
  const dnsList = asStringList(endpoints.nodes_dns).map(trimDot);
  if (!clusterDns && !ips.length && !dnsList.length) return [];
  const ssh = asString(endpoints.how_to_ssh);
  const fallbackZone = parseSshZone(ssh);
  const node1Name = parseSshName(ssh);
  const prefix = node1Name.replace(/-1$/, "");
  const suffixes = ctx.region_zones?.length
    ? ctx.region_zones
    : fallbackZone
      ? [fallbackZone.replace(/^.*-/, "")]
      : [];
  const region = ctx.region || fallbackZone.replace(/-[a-z]$/, "");
  const machineType = ctx.machine_type || "";
  const nodeCount = Math.max(ips.length, dnsList.length, 1);
  const nodes: AccessNode[] = [];
  for (let n = 0; n < nodeCount; n++) {
    const zone = zoneForIndex(region, suffixes, n) || fallbackZone;
    const name = nodeNameFromPrefix(prefix, n, node1Name);
    nodes.push({
      name,
      dns: dnsList[n] || (clusterDns ? `node${n + 1}.${dnsSuffixFromClusterDns(clusterDns)}` : ""),
      ip: ips[n] || "",
      zone,
      machineType,
      ssh: sshCommand(name, zone),
    });
  }
  return [
    {
      id: "cluster-1",
      label: "Cluster 1",
      machineType,
      nodeCount: nodes.length,
      clusterDns,
      uiUrl: nodeUiUrl(clusterDns) || withUiPort(nodes[0]?.dns || ""),
      uiIpUrl: withUiPort(asString(endpoints.rs_ui_ip) || ips[0] || ""),
      adminUsername: asString(endpoints.admin_username),
      adminPassword: asString(endpoints.admin_password),
      nodes,
    },
  ];
}

function gkeClusters(endpoints: Record<string, unknown>): AccessCluster[] {
  const recs = Array.isArray(endpoints.recs) ? endpoints.recs : [];
  if (!recs.length) {
    const ui = withUiPort(asString(endpoints.rec_ui_url));
    if (!ui) return [];
    return [
      {
        id: "rec-1",
        label: asString(endpoints.rec_name) || "REC",
        machineType: "",
        nodeCount: 0,
        clusterDns: "",
        uiUrl: ui,
        uiIpUrl: ui,
        adminUsername: asString(endpoints.admin_username),
        adminPassword: asString(endpoints.admin_password),
        nodes: [],
      },
    ];
  }
  return recs.map((raw, i) => {
    const c = asRecord(raw) || {};
    const ui = withUiPort(asString(c.ui || c.rec_ui_url));
    return {
      id: `rec-${i + 1}`,
      label: asString(c.name) || asString(endpoints.rec_names && asStringList(endpoints.rec_names)[i]) || `REC ${i + 1}`,
      machineType: "",
      nodeCount: 0,
      clusterDns: "",
      uiUrl: ui,
      uiIpUrl: ui,
      adminUsername: asString(c.admin_username) || asString(endpoints.admin_username),
      adminPassword: asString(c.admin_password) || asString(endpoints.admin_password),
      nodes: [],
    };
  });
}

function appVms(endpoints: Record<string, unknown>, ctx: AccessContext): AccessAppVm[] {
  const listedCompanion = Array.isArray(endpoints.apps) ? endpoints.apps : [];
  const listedWorkloads = Array.isArray(endpoints.app_workloads) ? endpoints.app_workloads : [];
  const listed = listedCompanion.length ? listedCompanion : listedWorkloads;
  const names = asStringList(endpoints.app_names);
  const ips = asStringList(endpoints.app_ips);
  const dns = asStringList(endpoints.app_dns).map(trimDot);
  const types = asStringList(endpoints.app_machine_types);
  const sshList = asStringList(endpoints.how_to_ssh_to_app);
  const hintZone = parseSshZone(sshList[0] || "");
  const fallbackZone =
    hintZone || zoneForIndex(ctx.region || "", ctx.region_zones || [], 0);
  const count = Math.max(listed.length, names.length, ips.length, dns.length, types.length, sshList.length);
  const httpUrl = asString(endpoints.app_http_url);
  const httpsUrl = asString(endpoints.app_https_url);

  const rows: AccessAppVm[] = [];
  for (let i = 0; i < count; i++) {
    const item = asRecord(listed[i]) || {};
    const name = asString(item.name) || names[i] || "";
    const zone = asString(item.zone) || fallbackZone;
    const host = trimDot(asString(item.dns) || dns[i] || "");
    rows.push({
      id: `app-${i + 1}`,
      label: count > 1 ? `App VM ${i + 1}` : "App VM",
      name,
      dns: host,
      ip: asString(item.ip) || ips[i] || "",
      machineType: asString(item.machine_type) || types[i] || "",
      zone,
      ssh: withSshZone(asString(item.how_to_ssh) || sshList[i], name, zone),
      httpUrl: asString(item.http_url) || (i === 0 ? httpUrl : host && httpUrl ? `http://${host}` : ""),
      httpsUrl: asString(item.https_url) || (i === 0 ? httpsUrl : host && httpsUrl ? `https://${host}` : ""),
    });
  }
  return rows;
}

export function buildAccessView(
  endpoints: Record<string, unknown> | undefined,
  ctx: AccessContext = {},
): AccessView {
  const ep = endpoints || {};
  const kubectl = asString(ep.how_to_kubectl) || undefined;
  if (ctx.mode === "gke") {
    return { clusters: gkeClusters(ep), apps: [], kubectl };
  }
  const clusters = vmClustersFromList(ep, ctx);
  const apps = appVms(ep, ctx);
  return {
    clusters: clusters.length || apps.length ? clusters : vmClusterFromFlat(ep, ctx),
    apps,
    kubectl,
  };
}

export const ACCESS_ENDPOINT_KEYS = new Set([
  "rs_ui_dns",
  "rs_ui_ip",
  "rs_cluster_dns",
  "nodes_ip",
  "nodes_dns",
  "how_to_ssh",
  "how_to_ssh_to_app",
  "how_to_kubectl",
  "app_names",
  "app_machine_types",
  "app_ips",
  "app_dns",
  "apps",
  "clusters",
  "rec_names",
  "rec_name",
  "rec_ui_url",
  "recs",
  "admin_username",
  "admin_password",
  "app_http_url",
  "app_https_url",
  "gke_cluster_name",
  "gke_cluster_endpoint",
  "rec_namespace",
]);
