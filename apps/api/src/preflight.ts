import fs from "node:fs";
import { readRegistry } from "./registry.js";
import { resolveSshPublicKey } from "./workspace.js";
import {
  GcpApiError,
  listDnsZones,
  listEnabledServices,
  getMachineType,
  getProject,
  getRegion,
  gkeClusterExists,
  networkExists,
  readKey,
} from "./gcp.js";
import { LOCAL_SSD_GIB, maxLocalSsdsForMachineType } from "./nvme.js";
import { describeAppWebExposure, normalizeAppMachineTypes, summarizeAppMachineTypes } from "./app-web.js";
import { iamHint } from "./quotas.js";
import type { CreateInstanceInput } from "./types.js";

export type CheckLevel = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  instanceId: string;
  checks: CheckResult[];
}

function pass(id: string, label: string, detail: string): CheckResult {
  return { id, label, level: "pass", detail };
}

function warn(id: string, label: string, detail: string): CheckResult {
  return { id, label, level: "warn", detail };
}

function fail(id: string, label: string, detail: string): CheckResult {
  return { id, label, level: "fail", detail };
}

function errorText(err: unknown): string {
  const base =
    err instanceof GcpApiError
      ? `${err.message} (HTTP ${err.status})`
      : err instanceof Error
        ? err.message
        : String(err);
  const hint = iamHint(base);
  return hint ? `${base} — ${hint}` : base;
}

const REQUIRED_SERVICES: Record<string, string[]> = {
  vm: ["compute.googleapis.com", "dns.googleapis.com"],
  gke: ["compute.googleapis.com", "container.googleapis.com"],
};

export async function preflight(input: CreateInstanceInput): Promise<PreflightResult> {
  const checks: CheckResult[] = [];
  const mode = input.mode;
  const env = input.env || "default";
  const instanceId = `${input.name}-${env}`;
  const namePrefix = instanceId;
  const region = input.region_name || "europe-west1";
  const credentialsFile = input.credentialsFile;

  // 1. Instance name uniqueness in the local registry
  const existing = await readRegistry();
  if (existing.some((i) => i.id === instanceId)) {
    checks.push(fail("name", "Instance name", `${instanceId} already exists in this wizard`));
  } else {
    checks.push(pass("name", "Instance name", `${instanceId} is available`));
  }

  // 2. Credentials readable and usable
  let projectFromKey = "";
  try {
    const key = readKey(credentialsFile);
    if (key.type !== "service_account") {
      checks.push(fail("credentials", "Credentials", "Key is not a service_account JSON"));
      return { ok: false, instanceId, checks };
    }
    projectFromKey = key.project_id || "";
    checks.push(pass("credentials", "Credentials", `${key.client_email}`));
  } catch (err) {
    checks.push(fail("credentials", "Credentials", errorText(err)));
    return { ok: false, instanceId, checks };
  }

  const project = input.project || projectFromKey;
  if (!project) {
    checks.push(fail("project", "GCP project", "No project selected"));
    return { ok: false, instanceId, checks };
  }

  // 3. Project reachable with these credentials (also proves auth works)
  try {
    const info = await getProject(credentialsFile, project);
    checks.push(pass("project", "GCP project", `${info.name} (${info.projectId})`));
  } catch (err) {
    checks.push(
      fail(
        "project",
        "GCP project",
        `Cannot access ${project} with this service account: ${errorText(err)}`,
      ),
    );
    return { ok: false, instanceId, checks };
  }

  // 4. Required APIs enabled
  try {
    const enabled = await listEnabledServices(credentialsFile, project);
    const missing = REQUIRED_SERVICES[mode].filter((s) => !enabled.includes(s));
    if (missing.length) {
      checks.push(
        fail("apis", "Required APIs", `Not enabled in ${project}: ${missing.join(", ")}`),
      );
    } else {
      checks.push(pass("apis", "Required APIs", REQUIRED_SERVICES[mode].join(", ")));
    }
  } catch (err) {
    checks.push(
      warn(
        "apis",
        "Required APIs",
        `Could not verify (serviceusage permission missing): ${errorText(err)}`,
      ),
    );
  }

  // 5. Region and zones
  const zoneSuffixes = input.region_zones || ["b", "c", "d"];
  let usableZones: string[] = [];
  try {
    const regionInfo = await getRegion(credentialsFile, project, region);
    const invalid = zoneSuffixes.filter((z) => !regionInfo.zoneSuffixes.includes(z));
    usableZones = zoneSuffixes
      .filter((z) => regionInfo.zoneSuffixes.includes(z))
      .map((z) => `${region}-${z}`);

    if (invalid.length) {
      checks.push(
        fail(
          "zones",
          "Region and zones",
          `${region} has zones [${regionInfo.zoneSuffixes.join(", ")}]; invalid: ${invalid.join(", ")}`,
        ),
      );
    } else {
      checks.push(pass("zones", "Region and zones", `${region} [${zoneSuffixes.join(", ")}]`));
    }

    // 6. CPU quota in region
    const nodes = mode === "vm" ? (input.clustersize ?? 3) : (input.gke_clustersize ?? 3);
    const nodeMachine =
      mode === "vm" ? input.machine_type || "e2-standard-2" : input.gke_machine_type || "e2-standard-8";
    const probeZone = usableZones[0] || `${region}-b`;

    try {
      const mt = await getMachineType(credentialsFile, project, probeZone, nodeMachine);
      const clusterCpus = mt.guestCpus * nodes;
      let appCpus = 0;
      const appCount = mode === "vm" ? (input.app ?? 0) : 0;
      const appTypes =
        appCount > 0
          ? normalizeAppMachineTypes({
              app: appCount,
              app_machine_types: input.app_machine_types,
              app_machine_type: input.app_machine_type,
            })
          : [];
      if (appTypes.length) {
        for (const appMachine of appTypes) {
          const appMt = await getMachineType(credentialsFile, project, probeZone, appMachine);
          appCpus += appMt.guestCpus;
        }
      }
      const requiredCpus = clusterCpus + appCpus;
      const breakdown = appCpus
        ? ` (${clusterCpus} for ${nodes} Redis node(s) + ${appCpus} for ${appCount} app VM(s): ${summarizeAppMachineTypes(appTypes)})`
        : "";

      const cpuQuota = regionInfo.quotas.find((q) => q.metric === "CPUS");
      if (cpuQuota) {
        const available = cpuQuota.limit - cpuQuota.usage;
        if (requiredCpus > available) {
          checks.push(
            fail(
              "quota",
              "CPU quota",
              `Needs ${requiredCpus} vCPU${breakdown} in ${region}, only ${available} available (limit ${cpuQuota.limit}, in use ${cpuQuota.usage})`,
            ),
          );
        } else {
          checks.push(
            pass(
              "quota",
              "CPU quota",
              `${requiredCpus} of ${available} available vCPU in ${region}${breakdown}`,
            ),
          );
        }
      } else {
        checks.push(warn("quota", "CPU quota", "Region quota not reported"));
      }
    } catch (err) {
      checks.push(warn("quota", "CPU quota", `Could not compute: ${errorText(err)}`));
    }
  } catch (err) {
    checks.push(fail("zones", "Region and zones", `Cannot read region ${region}: ${errorText(err)}`));
  }

  // 7. Machine type available in every selected zone
  const machineType =
    mode === "vm" ? input.machine_type || "e2-standard-2" : input.gke_machine_type || "e2-standard-8";
  const zonesToCheck = usableZones.length ? usableZones : [`${region}-b`];
  const zonesForMachine = mode === "vm" ? zonesToCheck : [zonesToCheck[0]];
  const missingIn: string[] = [];
  let machineDetail = "";
  let machineArm = false;
  for (const zone of zonesForMachine) {
    try {
      const mt = await getMachineType(credentialsFile, project, zone, machineType);
      machineDetail = `${mt.name} — ${mt.guestCpus} vCPU, ${Math.round(mt.memoryMb / 1024)} GB`;
      machineArm = mt.architecture === "ARM64";
    } catch (err) {
      if (err instanceof GcpApiError && err.status === 404) {
        missingIn.push(zone);
      } else {
        missingIn.push(`${zone} (${errorText(err)})`);
      }
    }
  }
  if (missingIn.length) {
    checks.push(
      fail(
        "machine_type",
        "Machine type",
        `${machineType} unavailable in: ${missingIn.join(", ")}`,
      ),
    );
  } else if (machineArm) {
    checks.push(
      fail(
        "machine_type",
        "Machine type",
        `${machineType} is Arm (ARM64) and the Ubuntu 22.04 image used here is x86_64. Pick an x86 type such as n2-standard-8.`,
      ),
    );
  } else {
    checks.push(pass("machine_type", "Machine type", machineDetail || machineType));
  }

  // 8. Redis Enterprise sizing sanity
  if (mode === "vm") {
    const nodes = input.clustersize ?? 3;
    if (nodes === 2) {
      checks.push(
        warn(
          "sizing",
          "Cluster sizing",
          "2 nodes cannot form a quorum for HA; use 1 for testing or 3+ for HA",
        ),
      );
    } else if (nodes >= 3 && nodes % 2 === 0) {
      checks.push(warn("sizing", "Cluster sizing", `${nodes} nodes — an odd count is recommended`));
    } else {
      checks.push(pass("sizing", "Cluster sizing", `${nodes} node(s)`));
    }
  } else {
    const recNodes = input.rec_nodes ?? 3;
    const gkeNodes = input.gke_clustersize ?? 3;
    if (recNodes % 2 === 0) {
      checks.push(warn("sizing", "REC sizing", `${recNodes} REC nodes — must be odd for HA`));
    } else if (gkeNodes < recNodes) {
      checks.push(
        fail(
          "sizing",
          "REC sizing",
          `${recNodes} REC pods need at least ${recNodes} GKE nodes (anti-affinity), have ${gkeNodes}`,
        ),
      );
    } else {
      checks.push(pass("sizing", "REC sizing", `${recNodes} REC nodes on ${gkeNodes} GKE nodes`));
    }
  }

  // 9. DNS managed zone (VM mode relies on it for cluster DNS)
  if (mode === "vm") {
    const zoneName = input.dns_managed_zone || "demo-clusters";
    const dnsName = input.dns_zone_dns_name || "demo.redislabs.com";
    try {
      const zones = await listDnsZones(credentialsFile, project);
      const found = zones.find((z) => z.name === zoneName);
      if (!found) {
        checks.push(
          fail(
            "dns",
            "DNS managed zone",
            zones.length
              ? `${zoneName} not found. Available: ${zones.map((z) => z.name).join(", ")}`
              : `${zoneName} not found and no managed zones exist in ${project}`,
          ),
        );
      } else if (found.dnsName !== dnsName) {
        checks.push(
          fail("dns", "DNS managed zone", `${zoneName} serves ${found.dnsName}, not ${dnsName}`),
        );
      } else {
        checks.push(pass("dns", "DNS managed zone", `${zoneName} → ${found.dnsName}`));
      }
    } catch (err) {
      checks.push(warn("dns", "DNS managed zone", `Could not verify: ${errorText(err)}`));
    }
  }

  // 10. Name collisions with existing GCP resources
  try {
    if (await networkExists(credentialsFile, project, `${namePrefix}-vpc`)) {
      checks.push(
        fail("collision", "Resource names", `VPC ${namePrefix}-vpc already exists in ${project}`),
      );
    } else if (
      mode === "gke" &&
      (await gkeClusterExists(credentialsFile, project, `${region}-b`, `${namePrefix}-gke`))
    ) {
      checks.push(
        fail("collision", "Resource names", `GKE cluster ${namePrefix}-gke already exists`),
      );
    } else {
      checks.push(pass("collision", "Resource names", `${namePrefix}-* is free in ${project}`));
    }
  } catch (err) {
    checks.push(warn("collision", "Resource names", `Could not verify: ${errorText(err)}`));
  }

  // 11. SSH key for VM mode
  if (mode === "vm") {
    try {
      const key = resolveSshPublicKey();
      checks.push(pass("ssh", "SSH public key", `${key.slice(0, 32)}…`));
    } catch (err) {
      checks.push(fail("ssh", "SSH public key", errorText(err)));
    }
  }

  // 12. Redis Enterprise release URL reachable (VM mode)
  if (mode === "vm") {
    const url =
      input.RS_release ||
      "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar";
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const size = Number(res.headers.get("content-length") || 0);
        checks.push(
          pass(
            "release",
            "Redis Enterprise release",
            size ? `${url.split("/").pop()} (${Math.round(size / 1024 / 1024)} MB)` : "reachable",
          ),
        );
      } else {
        checks.push(warn("release", "Redis Enterprise release", `HEAD returned ${res.status}`));
      }
    } catch (err) {
      checks.push(warn("release", "Redis Enterprise release", `Not reachable: ${errorText(err)}`));
    }
  }

  // 12b. Local NVMe / Redis on Flash (VM only)
  if (mode === "vm") {
    const nvme = input.rof_nvme_disks ?? 0;
    const machine = input.machine_type || "e2-standard-2";
    const max = maxLocalSsdsForMachineType(machine);
    const nodes = input.clustersize ?? 3;
    if (nvme === 0) {
      checks.push(pass("nvme", "Local NVMe disks", "0 — standard RAM-only cluster"));
    } else if (max === 0) {
      checks.push(
        fail(
          "nvme",
          "Local NVMe disks",
          `${machine} does not support Local SSD / NVMe. Choose an n2/n2d/c2/c3 family machine type, or set NVMe to 0.`,
        ),
      );
    } else if (max !== undefined && nvme > max) {
      checks.push(
        fail(
          "nvme",
          "Local NVMe disks",
          `${machine} supports at most ${max} Local SSD(s); requested ${nvme}`,
        ),
      );
    } else {
      const totalGib = nodes * nvme * LOCAL_SSD_GIB;
      checks.push(
        pass(
          "nvme",
          "Local NVMe disks",
          `Redis on Flash: ${nvme} × ${LOCAL_SSD_GIB} GiB per node × ${nodes} nodes ≈ ${totalGib} GiB flash`,
        ),
      );
    }
  }

  // 12c. Companion app / memtier VMs (VM only)
  if (mode === "vm") {
    const appCount = input.app ?? 0;
    const appZone = usableZones[0] || `${region}-b`;
    const appHost = `app.${namePrefix}.${input.dns_zone_dns_name || "demo.redislabs.com"}`;

    if (appCount === 0) {
      checks.push(pass("app_vms", "App VMs", "0 — no companion app / memtier VMs"));
    } else {
      const appTypes = normalizeAppMachineTypes({
        app: appCount,
        app_machine_types: input.app_machine_types,
        app_machine_type: input.app_machine_type,
      });
      const exposeHttp = Boolean(input.app_expose_http);
      const exposeHttps = Boolean(input.app_expose_https);
      const webDetail = describeAppWebExposure({ exposeHttp, exposeHttps });
      const details: string[] = [];
      let failed = false;
      for (let i = 0; i < appTypes.length; i++) {
        const appMachine = appTypes[i];
        try {
          const mt = await getMachineType(credentialsFile, project, appZone, appMachine);
          if (mt.architecture === "ARM64") {
            failed = true;
            checks.push(
              fail(
                `app_vm_${i}`,
                `App VM ${i + 1}`,
                `${appMachine} is Arm (ARM64) and the app VM image is x86_64. Pick an x86 type such as n2-standard-8.`,
              ),
            );
          } else {
            details.push(
              `#${i + 1} ${appMachine} (${mt.guestCpus} vCPU, ${Math.round(mt.memoryMb / 1024)} GB)`,
            );
          }
        } catch (err) {
          failed = true;
          if (err instanceof GcpApiError && err.status === 404) {
            checks.push(
              fail(
                `app_vm_${i}`,
                `App VM ${i + 1}`,
                `Machine type ${appMachine} is not available in ${appZone}.`,
              ),
            );
          } else {
            checks.push(
              fail(
                `app_vm_${i}`,
                `App VM ${i + 1}`,
                `Cannot verify ${appMachine} in ${appZone}: ${errorText(err)}`,
              ),
            );
          }
        }
      }
      if (!failed) {
        checks.push(
          pass(
            "app_vms",
            "App VMs",
            `${appCount} in ${appZone}: ${details.join("; ")} · DNS ${appHost}`,
          ),
        );
      }
      checks.push(
        pass(
          "app_web",
          "App VM web ports",
          `${webDetail}${exposeHttp ? ` · http://${appHost}` : ""}${exposeHttps ? ` · https://${appHost}` : ""}`,
        ),
      );
    }

    if (input.memviz_enabled) {
      const port = input.memviz_port ?? 3000;
      if (appCount === 0) {
        checks.push(
          fail("memviz", "Memviz", "Memviz runs on an app VM — set at least 1 app VM or disable it"),
        );
      } else {
        checks.push(pass("memviz", "Memviz", `http://${appHost}:${port} on the first app VM`));
      }
    }
  }

  // 13. Terraform binary present in this container
  const terraformOnPath = (process.env.PATH || "")
    .split(":")
    .some((dir) => dir && fs.existsSync(`${dir}/terraform`));
  if (terraformOnPath) {
    checks.push(pass("terraform", "Terraform binary", "found on PATH"));
  } else {
    checks.push(fail("terraform", "Terraform binary", "terraform not found on PATH"));
  }

  return {
    ok: !checks.some((c) => c.level === "fail"),
    instanceId,
    checks,
  };
}
