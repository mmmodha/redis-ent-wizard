import fs from "node:fs";
import { readRegistry } from "./registry.js";
import { resolveSshPublicKey } from "./workspace.js";
import {
  GcpApiError,
  listDnsZones,
  dnsNameExists,
  listEnabledServices,
  getMachineType,
  getProject,
  getRegion,
  gkeClusterExists,
  networkExists,
  readKey,
  testIamPermissions,
  STORAGE_READ_PERMISSIONS,
} from "./gcp.js";
import { normalizeApplications } from "./applications.js";
import { capacityFor } from "./databases.js";
import { clusterTrialShardGate } from "./trial-shards.js";
import { LOCAL_SSD_GIB, maxLocalSsdsForMachineType } from "./nvme.js";
import {
  describeAppWebExposure,
  normalizeAppDiskGib,
  normalizeAppMachineTypes,
  parseAppExtraPorts,
  summarizeAppDiskGib,
  summarizeAppMachineTypes,
} from "./app-web.js";
import { iamHint } from "./quotas.js";
import { clusterNamePrefix, normalizeClusters, plannedDnsNames, summarizeClusters, totalClusterNodes } from "./clusters.js";
import type { CreateInstanceInput, DatabaseSpec } from "./types.js";

function fmtGib(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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

export async function preflight(
  input: CreateInstanceInput,
  opts?: { allowExistingId?: string },
): Promise<PreflightResult> {
  const checks: CheckResult[] = [];
  const mode = input.mode;
  const env = input.env || "default";
  const instanceId = `${input.name}-${env}`;
  const namePrefix = instanceId;
  const region = input.region_name || "europe-west1";
  const credentialsFile = input.credentialsFile;

  // 1. Instance name uniqueness in the local registry. A destroyed instance is
  // overwriteable (create replaces it), so re-provisioning the same name is
  // allowed; a live one still blocks.
  const existing = await readRegistry();
  const clash = existing.find((i) => i.id === instanceId);
  if (clash && clash.id === opts?.allowExistingId) {
    checks.push(pass("name", "Instance name", `${instanceId} (re-provisioning this instance)`));
  } else if (clash && clash.status === "destroyed") {
    checks.push(pass("name", "Instance name", `${instanceId} will replace the destroyed instance`));
  } else if (clash) {
    checks.push(
      fail(
        "name",
        "Instance name",
        `${instanceId} already exists (${clash.status}) — destroy it first, or pick another name`,
      ),
    );
  } else {
    checks.push(pass("name", "Instance name", `${instanceId} is available`));
  }

  let clusters;
  try {
    clusters = normalizeClusters(input);
  } catch (err) {
    checks.push(
      fail("clusters", "Redis clusters", err instanceof Error ? err.message : String(err)),
    );
    return { ok: false, instanceId, checks };
  }

  checks.push(
    pass(
      "cluster_names",
      "Cluster names",
      clusters.map((c, i) => clusterNamePrefix(namePrefix, i, c.name)).join(", "),
    ),
  );

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
    const probeZone = usableZones[0] || `${region}-b`;

    try {
      let clusterCpus = 0;
      let redisNodes = 0;
      if (mode === "vm") {
        for (const c of clusters) {
          const mt = await getMachineType(credentialsFile, project, probeZone, c.machine_type);
          clusterCpus += mt.guestCpus * c.nodes;
          redisNodes += c.nodes;
        }
      } else {
        const nodeMachine = input.gke_machine_type || "e2-standard-8";
        const gkeNodes = input.gke_clustersize ?? 3;
        const mt = await getMachineType(credentialsFile, project, probeZone, nodeMachine);
        clusterCpus = mt.guestCpus * gkeNodes;
        redisNodes = gkeNodes;
      }
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
        ? ` (${clusterCpus} for ${redisNodes} Redis node(s) across ${clusters.length} cluster(s) + ${appCpus} for ${appCount} app VM(s): ${summarizeAppMachineTypes(appTypes)})`
        : ` (${summarizeClusters(clusters)})`;

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
  const zonesToCheck = usableZones.length ? usableZones : [`${region}-b`];
  if (mode === "vm") {
    for (let i = 0; i < clusters.length; i++) {
      const machineType = clusters[i].machine_type;
      const missingIn: string[] = [];
      let machineDetail = "";
      let machineArm = false;
      for (const zone of zonesToCheck) {
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
      const label = clusters.length > 1 ? `Cluster ${i + 1} machine type` : "Machine type";
      const id = clusters.length > 1 ? `machine_type_${i}` : "machine_type";
      if (missingIn.length) {
        checks.push(fail(id, label, `${machineType} unavailable in: ${missingIn.join(", ")}`));
      } else if (machineArm) {
        checks.push(
          fail(
            id,
            label,
            `${machineType} is Arm (ARM64) and the Ubuntu 22.04 image used here is x86_64. Pick an x86 type such as n2-standard-8.`,
          ),
        );
      } else {
        checks.push(pass(id, label, machineDetail || machineType));
      }
    }
  } else {
    const machineType = input.gke_machine_type || "e2-standard-8";
    const zone = zonesToCheck[0];
    try {
      const mt = await getMachineType(credentialsFile, project, zone, machineType);
      if (mt.architecture === "ARM64") {
        checks.push(
          fail(
            "machine_type",
            "Machine type",
            `${machineType} is Arm (ARM64). Pick an x86 type such as e2-standard-8.`,
          ),
        );
      } else {
        checks.push(
          pass(
            "machine_type",
            "Machine type",
            `${mt.name} — ${mt.guestCpus} vCPU, ${Math.round(mt.memoryMb / 1024)} GB`,
          ),
        );
      }
    } catch (err) {
      checks.push(
        fail("machine_type", "Machine type", `${machineType} unavailable in ${zone}: ${errorText(err)}`),
      );
    }
  }

  // 8. Redis Enterprise sizing sanity
  if (mode === "vm") {
    for (let i = 0; i < clusters.length; i++) {
      const nodes = clusters[i].nodes;
      const id = clusters.length > 1 ? `sizing_${i}` : "sizing";
      const label = clusters.length > 1 ? `Cluster ${i + 1} sizing` : "Cluster sizing";
      if (nodes === 2) {
        checks.push(
          warn(id, label, "2 nodes cannot form a quorum for HA; use 1 for testing or 3+ for HA"),
        );
      } else if (nodes >= 3 && nodes % 2 === 0) {
        checks.push(warn(id, label, `${nodes} nodes — an odd count is recommended`));
      } else {
        checks.push(
          pass(
            id,
            label,
            `${nodes} node(s)${clusters.length > 1 ? ` · ${clusters[i].rs_version}` : ""}`,
          ),
        );
      }
    }
  } else {
    const gkeNodes = input.gke_clustersize ?? 3;
    const maxRec = Math.max(...clusters.map((c) => c.rec_nodes));
    const sumRec = totalClusterNodes(clusters);
    if (clusters.some((c) => c.rec_nodes % 2 === 0)) {
      checks.push(
        warn(
          "sizing",
          "REC sizing",
          `${clusters.map((c) => c.rec_nodes).join(", ")} REC nodes — odd counts are recommended for HA`,
        ),
      );
    }
    if (gkeNodes < maxRec) {
      checks.push(
        fail(
          "sizing",
          "REC sizing",
          `Largest REC needs ${maxRec} GKE nodes (anti-affinity), pool has ${gkeNodes}`,
        ),
      );
    } else if (gkeNodes < sumRec) {
      checks.push(
        warn(
          "sizing",
          "REC sizing",
          `${sumRec} REC pods on ${gkeNodes} GKE nodes — they will share nodes. ${sumRec}+ GKE nodes is safer.`,
        ),
      );
    } else {
      checks.push(
        pass(
          "sizing",
          "REC sizing",
          `${clusters.length} REC(s), ${sumRec} pods on ${gkeNodes} GKE nodes`,
        ),
      );
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
        try {
          const hosts = plannedDnsNames({
            deploymentPrefix: namePrefix,
            dnsZone: dnsName,
            clusters,
            appCount: input.app ?? 0,
          });
          const results = await Promise.all(
            hosts.map(async (host) => ({
              host,
              exists: await dnsNameExists(credentialsFile, project, zoneName, host),
            })),
          );
          const taken = results.filter((r) => r.exists).map((r) => r.host);
          if (taken.length) {
            const shown = taken.slice(0, 6).join(", ");
            const extra = taken.length > 6 ? ` (+${taken.length - 6} more)` : "";
            checks.push(
              fail(
                "dns_records",
                "DNS records",
                `${taken.length} name(s) already exist in ${zoneName}: ${shown}${extra}. Pick a different instance name, env, or cluster name — a colleague may already be using this prefix.`,
              ),
            );
          } else {
            checks.push(
              pass(
                "dns_records",
                "DNS records",
                `${hosts.length} name(s) free in ${zoneName} (cluster/node/app FQDNs)`,
              ),
            );
          }
        } catch (err) {
          checks.push(warn("dns_records", "DNS records", `Could not verify: ${errorText(err)}`));
        }
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
    const seen = new Set<string>();
    for (let i = 0; i < clusters.length; i++) {
      const url = clusters[i].RS_release;
      if (seen.has(url)) continue;
      seen.add(url);
      const id = seen.size === 1 && clusters.length === 1 ? "release" : `release_${i}`;
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const size = Number(res.headers.get("content-length") || 0);
          checks.push(
            pass(
              id,
              "Redis Enterprise release",
              size
                ? `${clusters[i].rs_version} · ${url.split("/").pop()} (${Math.round(size / 1024 / 1024)} MB)`
                : `${clusters[i].rs_version} reachable`,
            ),
          );
        } else {
          checks.push(warn(id, "Redis Enterprise release", `${clusters[i].rs_version}: HEAD ${res.status}`));
        }
      } catch (err) {
        checks.push(
          warn(id, "Redis Enterprise release", `${clusters[i].rs_version} not reachable: ${errorText(err)}`),
        );
      }
    }
  }

  // 12b. Local NVMe / Redis on Flash (VM only)
  if (mode === "vm") {
    for (let i = 0; i < clusters.length; i++) {
      const nvme = clusters[i].rof_nvme_disks;
      const machine = clusters[i].machine_type;
      const max = maxLocalSsdsForMachineType(machine);
      const nodes = clusters[i].nodes;
      const id = clusters.length > 1 ? `nvme_${i}` : "nvme";
      const label = clusters.length > 1 ? `Cluster ${i + 1} NVMe` : "Local NVMe disks";
      if (nvme === 0) {
        checks.push(pass(id, label, "0 — standard RAM-only cluster"));
      } else if (max === 0) {
        checks.push(
          fail(
            id,
            label,
            `${machine} does not support Local SSD / NVMe. Choose an n2/n2d/c2/c3 family machine type, or set NVMe to 0.`,
          ),
        );
      } else if (max !== undefined && nvme > max) {
        checks.push(fail(id, label, `${machine} supports at most ${max} Local SSD(s); requested ${nvme}`));
      } else {
        const totalGib = nodes * nvme * LOCAL_SSD_GIB;
        checks.push(
          pass(
            id,
            label,
            `Redis on Flash: ${nvme} × ${LOCAL_SSD_GIB} GiB per node × ${nodes} nodes ≈ ${totalGib} GiB flash`,
          ),
        );
      }
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
      const disks = normalizeAppDiskGib({
        app: appCount,
        app_disk_gib: input.app_disk_gib,
      });
      let extraPorts: number[] = [];
      let extraPortsError = "";
      try {
        extraPorts = parseAppExtraPorts(input.app_extra_ports);
      } catch (err) {
        extraPortsError = err instanceof Error ? err.message : String(err);
      }
      const webDetail = describeAppWebExposure({ exposeHttp, exposeHttps, extraPorts });
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
            const extra = disks[i] > 0 ? `, +${disks[i]} GiB /data` : "";
            details.push(
              `#${i + 1} ${appMachine} (${mt.guestCpus} vCPU, ${Math.round(mt.memoryMb / 1024)} GB${extra})`,
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
            `${appCount} in ${appZone}: ${details.join("; ")} · ${summarizeAppDiskGib(disks)} · DNS ${appHost}`,
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
      if (extraPortsError) {
        checks.push(fail("app_extra_ports", "App extra TCP ports", extraPortsError));
      } else if (extraPorts.length) {
        checks.push(
          pass(
            "app_extra_ports",
            "App extra TCP ports",
            `${extraPorts.join(", ")} open from the internet on every App VM`,
          ),
        );
      }
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

  // 12d. Database capacity per cluster
  {
    const rawClusters = Array.isArray(input.clusters) ? input.clusters : [];
    const probeZone = usableZones[0] || `${region}-b`;
    for (let i = 0; i < clusters.length; i++) {
      const dbs = (rawClusters[i]?.databases as DatabaseSpec[] | undefined) || [];
      if (!dbs.length) continue;
      const id = clusters.length > 1 ? `databases_${i}` : "databases";
      const label = clusters.length > 1 ? `Cluster ${i + 1} databases` : "Databases";
      const names = dbs.map((d) => d.name);
      const ports = dbs.map((d) => d.port ?? 12000);
      if (new Set(names).size !== names.length) {
        checks.push(fail(id, label, "Database names must be unique within a cluster"));
        continue;
      }
      if (new Set(ports).size !== ports.length) {
        checks.push(fail(id, label, "Database ports must be unique within a cluster"));
        continue;
      }
      const flexDbs = dbs.filter((d) => d.flex);
      if (flexDbs.length && (mode !== "vm" || Number(clusters[i].rof_nvme_disks) <= 0)) {
        checks.push(
          fail(
            id,
            label,
            mode !== "vm"
              ? `Flex (Redis on Flash) databases are only supported on VM clusters with NVMe disks; disable Flex on ${flexDbs.map((d) => d.name).join(", ")}.`
              : `${flexDbs.length} Flex (Redis on Flash) database(s) need NVMe disks on this cluster; set NVMe disks on the cluster, or disable Flex.`,
          ),
        );
        continue;
      }
      const trial = clusterTrialShardGate({
        name: clusters[i].name,
        license: String(rawClusters[i]?.license || ""),
        databases: dbs,
        nodes: clusters[i].nodes,
      });
      if (trial.blocked) {
        checks.push(
          fail(
            clusters.length > 1 ? `trial_shards_${i}` : "trial_shards",
            "Trial license shards",
            trial.message,
          ),
        );
      }
      const machineType = mode === "vm" ? clusters[i].machine_type : input.gke_machine_type || "e2-standard-8";
      try {
        const mt = await getMachineType(credentialsFile, project, probeZone, machineType);
        const cap = capacityFor(clusters[i].nodes, mt.memoryMb, dbs);
        if (!cap.ok) {
          checks.push(
            fail(
              id,
              label,
              `${dbs.length} database(s) need ${fmtGib(cap.required)} but the cluster offers about ${fmtGib(cap.capacity)} usable (${clusters[i].nodes} × ${machineType}). Reduce memory, add nodes, or pick a larger machine type.`,
            ),
          );
        } else {
          checks.push(
            pass(
              id,
              label,
              `${dbs.length} database(s), ${fmtGib(cap.required)} of about ${fmtGib(cap.capacity)} usable, ${fmtGib(cap.remaining)} free`,
            ),
          );
        }
      } catch (err) {
        checks.push(warn(id, label, `Could not verify capacity: ${errorText(err)}`));
      }
    }
  }

  // 12e. Custom application workloads
  {
    let apps: ReturnType<typeof normalizeApplications> | null = null;
    try {
      apps = normalizeApplications({ mode, applications: input.applications });
    } catch (err) {
      checks.push(fail("applications", "Applications", err instanceof Error ? err.message : String(err)));
    }
    if (apps && apps.length) {
      const probeZone = usableZones[0] || `${region}-b`;
      let needGcsRead = false;
      let anyFail = false;
      for (const app of apps) {
        if (mode !== "vm") continue;
        if (app.artifact && app.artifact.kind === "gcs") {
          needGcsRead = true;
        }
        const machineType = app.machine_type || "e2-standard-2";
        try {
          const mt = await getMachineType(credentialsFile, project, probeZone, machineType);
          if (mt.architecture === "ARM64") {
            anyFail = true;
            checks.push(
              fail(`app_${app.name}`, `Application ${app.name}`, `${machineType} is Arm (ARM64); pick an x86 type such as e2-standard-2`),
            );
          }
        } catch (err) {
          anyFail = true;
          checks.push(
            fail(`app_${app.name}`, `Application ${app.name}`, `${machineType} unavailable in ${probeZone}: ${errorText(err)}`),
          );
        }
      }
      if (!anyFail) {
        checks.push(
          pass(
            "applications",
            "Applications",
            apps
              .map((a) =>
                mode === "vm"
                  ? `${a.name} (${a.vm_count} VM(s), ${a.command ? "auto-start" : "manual start"})`
                  : `${a.name} (${a.image}, ${a.replicas} replica(s))`,
              )
              .join("; "),
          ),
        );
      }
      if (needGcsRead) {
        try {
          const granted = await testIamPermissions(credentialsFile, project, STORAGE_READ_PERMISSIONS);
          const missing = STORAGE_READ_PERMISSIONS.filter((p) => !granted.includes(p));
          if (missing.length) {
            checks.push(
              fail(
                "app_storage",
                "Artifact read IAM",
                `Missing ${missing.join(", ")} — needed to read a gs:// application artifact. Grant roles/storage.objectViewer (uploaded and https artifacts need no storage role).`,
              ),
            );
          } else {
            checks.push(pass("app_storage", "Artifact read IAM", "gs:// artifact read permitted"));
          }
        } catch (err) {
          checks.push(warn("app_storage", "Artifact read IAM", `Could not verify: ${errorText(err)}`));
        }
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
