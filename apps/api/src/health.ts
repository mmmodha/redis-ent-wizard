import https from "node:https";
import net from "node:net";
import { normalizeClusters, totalClusterNodes } from "./clusters.js";
import type { ClusterHealth, CreateInstanceInput, InstanceRecord } from "./types.js";

const RE_API_PORT = 9443;
const RE_UI_PORT = 8443;

function tcpOpen(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

// Redis Enterprise serves its API with a self-signed certificate, so verification
// is disabled for these probes only rather than globally.
function getJson(
  url: string,
  auth?: { user: string; pass: string },
  timeoutMs = 6000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: auth
          ? {
              Authorization:
                "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
            }
          : undefined,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += String(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function expectedNodes(record: InstanceRecord): number {
  try {
    const cfg = (record.config || {}) as unknown as CreateInstanceInput;
    return totalClusterNodes(normalizeClusters({ ...cfg, mode: record.mode }));
  } catch {
    const cfg = record.config as Record<string, unknown> | undefined;
    const raw = record.mode === "gke" ? cfg?.rec_nodes : cfg?.clustersize;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : asStringArray(record.endpoints?.nodes_ip).length || 0;
  }
}

type ProbeTarget = { ips: string[]; user: string; pass: string; expected: number; label: string };

function vmTargets(record: InstanceRecord): ProbeTarget[] {
  const cfg = (record.config || {}) as unknown as CreateInstanceInput;
  if (totalClusterNodes(normalizeClusters({ ...cfg, mode: record.mode })) === 0) {
    return [];
  }
  const user = String(record.endpoints?.admin_username ?? "");
  const clusters = record.endpoints?.clusters;
  if (Array.isArray(clusters) && clusters.length) {
    return clusters.map((raw, i) => {
      const c = raw as Record<string, unknown>;
      return {
        ips: asStringArray(c.nodes_ip),
        user: String(c.admin_username ?? user),
        pass: String(c.admin_password ?? record.endpoints?.admin_password ?? ""),
        expected: Number(c.nodes) || asStringArray(c.nodes_ip).length || 1,
        label: `cluster ${i + 1}`,
      };
    });
  }
  return [
    {
      ips: asStringArray(record.endpoints?.nodes_ip),
      user,
      pass: String(record.endpoints?.admin_password ?? ""),
      expected: expectedNodes(record),
      label: "cluster",
    },
  ];
}

async function probeOneVm(target: ProbeTarget, now: string): Promise<ClusterHealth> {
  const base: ClusterHealth = {
    state: "installing",
    nodesActive: 0,
    nodesExpected: target.expected,
    uiReachable: false,
    checkedAt: now,
    detail: `Waiting for Redis Enterprise to install on ${target.label}`,
  };

  if (!target.ips.length) {
    return { ...base, state: "unknown", detail: `No node IPs for ${target.label} yet` };
  }

  const apiUp = await tcpOpen(target.ips[0], RE_API_PORT);
  if (!apiUp) {
    return {
      ...base,
      detail: `Installing Redis Enterprise on ${target.label} (${target.expected} node(s))`,
    };
  }

  if (!target.user || !target.pass) {
    return {
      ...base,
      state: "unknown",
      detail: `${target.label} is up but admin credentials are not available`,
    };
  }

  let nodesActive = 0;
  try {
    const res = await getJson(`https://${target.ips[0]}:${RE_API_PORT}/v1/nodes`, {
      user: target.user,
      pass: target.pass,
    });
    if (res.status === 200) {
      const nodes = JSON.parse(res.body) as { status?: string }[];
      nodesActive = nodes.filter((n) => n.status === "active").length;
    } else if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        state: "bootstrapping",
        detail: `${target.label} API rejected the stored admin credentials`,
      };
    } else {
      return { ...base, state: "bootstrapping", detail: `${target.label} is forming` };
    }
  } catch {
    return { ...base, state: "bootstrapping", detail: `${target.label} API not answering yet` };
  }

  const uiReachable = await tcpOpen(target.ips[0], RE_UI_PORT);
  if (nodesActive >= target.expected && uiReachable) {
    return {
      state: "ready",
      nodesActive,
      nodesExpected: target.expected,
      uiReachable,
      checkedAt: now,
      detail: `${target.label}: all ${nodesActive} nodes active`,
    };
  }
  return {
    state: "bootstrapping",
    nodesActive,
    nodesExpected: target.expected,
    uiReachable,
    checkedAt: now,
    detail:
      nodesActive < target.expected
        ? `${target.label}: ${nodesActive} of ${target.expected} nodes have joined`
        : `${target.label}: waiting for the management UI`,
  };
}

async function probeVm(record: InstanceRecord): Promise<ClusterHealth> {
  const now = new Date().toISOString();
  const targets = vmTargets(record);
  if (!targets.length) {
    return {
      state: "ready",
      nodesActive: 0,
      nodesExpected: 0,
      uiReachable: false,
      checkedAt: now,
      detail: "Application VMs only — no Redis cluster",
    };
  }
  const results = await Promise.all(targets.map((t) => probeOneVm(t, now)));
  const nodesActive = results.reduce((n, r) => n + r.nodesActive, 0);
  const nodesExpected = results.reduce((n, r) => n + r.nodesExpected, 0) || expectedNodes(record);
  const uiReachable = results.every((r) => r.uiReachable);
  const allReady = results.every((r) => r.state === "ready");
  const anyUnknown = results.some((r) => r.state === "unknown");
  return {
    state: allReady ? "ready" : anyUnknown && results.every((r) => r.state === "unknown") ? "unknown" : "bootstrapping",
    nodesActive,
    nodesExpected,
    uiReachable,
    checkedAt: now,
    detail: allReady
      ? `All ${results.length} cluster(s) ready (${nodesActive} nodes)`
      : results.map((r) => r.detail).join(" · "),
  };
}

async function probeGke(record: InstanceRecord): Promise<ClusterHealth> {
  const now = new Date().toISOString();
  const nodesExpected = expectedNodes(record);
  const recs = Array.isArray(record.endpoints?.recs)
    ? (record.endpoints?.recs as Record<string, unknown>[])
    : [];
  const urls = recs.length
    ? recs.map((r) => String(r.ui || r.rec_ui_url || "")).filter(Boolean)
    : [String(record.endpoints?.rec_ui_url ?? "")].filter(Boolean);

  if (!urls.length) {
    return {
      state: "bootstrapping",
      nodesActive: 0,
      nodesExpected,
      uiReachable: false,
      checkedAt: now,
      detail: "Waiting for the REC load balancer address",
    };
  }

  const results = await Promise.all(
    urls.map(async (url, i) => {
      try {
        const res = await getJson(url);
        return { ok: res.status > 0, label: recs[i]?.name ? String(recs[i].name) : `REC ${i + 1}` };
      } catch {
        return { ok: false, label: recs[i]?.name ? String(recs[i].name) : `REC ${i + 1}` };
      }
    }),
  );
  const readyCount = results.filter((r) => r.ok).length;
  const reachable = readyCount === results.length;
  return {
    state: reachable ? "ready" : "bootstrapping",
    nodesActive: reachable ? nodesExpected : 0,
    nodesExpected,
    uiReachable: reachable,
    checkedAt: now,
    detail: reachable
      ? `${results.length} REC UI(s) answering`
      : results.map((r) => `${r.label}: ${r.ok ? "up" : "waiting"}`).join(" · "),
  };
}

export async function probeHealth(record: InstanceRecord): Promise<ClusterHealth> {
  return record.mode === "gke" ? probeGke(record) : probeVm(record);
}
