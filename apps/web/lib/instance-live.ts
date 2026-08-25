import type { DesignNode } from "./diagram";

export type DatabaseLiveState = {
  cluster: string;
  name: string;
  status: string;
  endpoint?: string;
  error?: string;
};

export function overlayInstanceLive(
  nodes: DesignNode[],
  input: {
    databaseStates?: DatabaseLiveState[];
    endpoints?: Record<string, unknown>;
  },
): DesignNode[] {
  const states = input.databaseStates || [];
  const endpoints = input.endpoints || {};
  const workloads = Array.isArray(endpoints.app_workloads)
    ? (endpoints.app_workloads as Record<string, unknown>[])
    : [];
  const clusters = Array.isArray(endpoints.clusters)
    ? (endpoints.clusters as Record<string, unknown>[])
    : [];

  return nodes.map((n) => {
    if (n.data.kind === "database") {
      const parent = nodes.find((c) => c.id === n.parentId);
      const clusterName = String((parent?.data as { name?: string } | undefined)?.name || "").trim();
      const match = states.find(
        (s) =>
          s.name === n.data.name &&
          (s.cluster === clusterName || s.cluster.endsWith(clusterName) || clusterName === s.cluster),
      );
      if (!match) return n;
      return {
        ...n,
        data: {
          ...n.data,
          liveStatus: match.status,
          liveDetail: match.error || match.endpoint || match.status,
        },
      };
    }
    if (n.data.kind === "application") {
      const name = String(n.data.name || "").trim();
      const wl = workloads.find((w) => String(w.app_name || w.name || "") === name);
      if (!wl) return n;
      const ip = String(wl.ip || "");
      const dns = String(wl.dns || "");
      return {
        ...n,
        data: {
          ...n.data,
          liveStatus: "ready",
          liveDetail: [dns, ip].filter(Boolean).join(" · "),
        },
      };
    }
    if (n.data.kind === "cluster") {
      const name = String(n.data.name || "").trim();
      const row = clusters.find((c) => String(c.name || "") === name) || (clusters.length === 1 ? clusters[0] : undefined);
      if (!row) return n;
      const ips = Array.isArray(row.nodes_ip) ? row.nodes_ip.map(String).join(", ") : "";
      return {
        ...n,
        data: {
          ...n.data,
          liveStatus: "ready",
          liveDetail: ips || String(row.dns || ""),
        },
      };
    }
    return n;
  });
}
