import https from "node:https";
import net from "node:net";
import type { ClusterHealth, InstanceRecord } from "./types.js";

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
  const cfg = record.config as Record<string, unknown> | undefined;
  const raw = record.mode === "gke" ? cfg?.rec_nodes : cfg?.clustersize;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : asStringArray(record.endpoints?.nodes_ip).length || 1;
}

async function probeVm(record: InstanceRecord): Promise<ClusterHealth> {
  const now = new Date().toISOString();
  const ips = asStringArray(record.endpoints?.nodes_ip);
  const nodesExpected = expectedNodes(record);
  const base: ClusterHealth = {
    state: "installing",
    nodesActive: 0,
    nodesExpected,
    uiReachable: false,
    checkedAt: now,
    detail: "Waiting for Redis Enterprise to install on the nodes",
  };

  if (!ips.length) {
    return { ...base, state: "unknown", detail: "No node IPs in Terraform outputs yet" };
  }

  const user = String(record.endpoints?.admin_username ?? "");
  const pass = String(record.endpoints?.admin_password ?? "");

  // node1 is the node that runs `rladmin cluster create`, so it answers first.
  const apiUp = await tcpOpen(ips[0], RE_API_PORT);
  if (!apiUp) {
    return {
      ...base,
      detail: `Installing Redis Enterprise software on ${nodesExpected} node(s) — this usually takes 5-10 minutes`,
    };
  }

  if (!user || !pass) {
    return {
      ...base,
      state: "unknown",
      detail: "Cluster is up but admin credentials are not available to verify it",
    };
  }

  let nodesActive = 0;
  try {
    const res = await getJson(`https://${ips[0]}:${RE_API_PORT}/v1/nodes`, { user, pass });
    if (res.status === 200) {
      const nodes = JSON.parse(res.body) as { status?: string }[];
      nodesActive = nodes.filter((n) => n.status === "active").length;
    } else if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        state: "bootstrapping",
        detail: "Cluster API is up but rejected the stored admin credentials",
      };
    } else {
      return { ...base, state: "bootstrapping", detail: "Cluster is forming" };
    }
  } catch {
    return { ...base, state: "bootstrapping", detail: "Cluster API not answering yet" };
  }

  const uiReachable = await tcpOpen(ips[0], RE_UI_PORT);

  if (nodesActive >= nodesExpected && uiReachable) {
    return {
      state: "ready",
      nodesActive,
      nodesExpected,
      uiReachable,
      checkedAt: now,
      detail: `All ${nodesActive} nodes active`,
    };
  }

  return {
    state: "bootstrapping",
    nodesActive,
    nodesExpected,
    uiReachable,
    checkedAt: now,
    detail:
      nodesActive < nodesExpected
        ? `${nodesActive} of ${nodesExpected} nodes have joined the cluster`
        : "Waiting for the management UI to answer",
  };
}

async function probeGke(record: InstanceRecord): Promise<ClusterHealth> {
  const now = new Date().toISOString();
  const nodesExpected = expectedNodes(record);
  const url = String(record.endpoints?.rec_ui_url ?? "");

  if (!url) {
    return {
      state: "bootstrapping",
      nodesActive: 0,
      nodesExpected,
      uiReachable: false,
      checkedAt: now,
      detail: "Waiting for the REC load balancer address",
    };
  }

  try {
    const res = await getJson(url);
    const reachable = res.status > 0;
    return {
      state: reachable ? "ready" : "bootstrapping",
      nodesActive: reachable ? nodesExpected : 0,
      nodesExpected,
      uiReachable: reachable,
      checkedAt: now,
      detail: reachable ? "REC UI is answering" : "REC UI not answering yet",
    };
  } catch {
    return {
      state: "bootstrapping",
      nodesActive: 0,
      nodesExpected,
      uiReachable: false,
      checkedAt: now,
      detail: "REC UI not reachable yet — the load balancer may still be provisioning",
    };
  }
}

export async function probeHealth(record: InstanceRecord): Promise<ClusterHealth> {
  return record.mode === "gke" ? probeGke(record) : probeVm(record);
}
