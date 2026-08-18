import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GcpApiError,
  getProject,
  readKey,
  testIamPermissions,
  type ServiceAccountKey,
} from "./gcp.js";
import { iamHint } from "./quotas.js";

export type VerifyMode = "shared" | "vm" | "gke";

export type PermissionSpec = {
  id: string;
  permission: string;
  label: string;
  modes: VerifyMode[];
  /** IAM role(s) that typically grant this permission */
  roles: string[];
};

export type PermissionCheck = {
  id: string;
  label: string;
  level: "pass" | "warn" | "fail";
  detail: string;
  guide?: string;
  permission?: string;
  modes: VerifyMode[];
};

export type PermissionReport = {
  checks: PermissionCheck[];
  modes: {
    vm: { ok: boolean; missing: string[] };
    gke: { ok: boolean; missing: string[] };
  };
};

export type CredentialVerifyResult = {
  ok: boolean;
  jsonValid: boolean;
  authOk: boolean;
  clientEmail: string;
  projectId: string;
  projectName?: string;
  checks: PermissionCheck[];
  modes: PermissionReport["modes"];
  recommended: string[];
};

/**
 * Permissions exercised by the wizard / Terraform for Redis Enterprise on GCP.
 * Checked via projects:testIamPermissions against the SA's project.
 *
 * `roles[0]` is always the least-privilege predefined role that covers create-time
 * need for that permission. Broader roles (e.g. compute.admin) are intentionally
 * omitted from recommendations.
 */
export const REQUIRED_PERMISSIONS: PermissionSpec[] = [
  {
    id: "rm-get",
    permission: "resourcemanager.projects.get",
    label: "Read project",
    modes: ["shared", "vm", "gke"],
    roles: ["roles/browser"],
  },
  {
    id: "su-get",
    permission: "serviceusage.services.get",
    label: "Read enabled APIs",
    modes: ["shared", "vm", "gke"],
    roles: ["roles/serviceusage.serviceUsageConsumer"],
  },
  {
    id: "compute-zones",
    permission: "compute.zones.get",
    label: "Read Compute zones",
    modes: ["shared", "vm", "gke"],
    roles: ["roles/compute.viewer"],
  },
  {
    id: "compute-mt",
    permission: "compute.machineTypes.get",
    label: "Read machine types",
    modes: ["shared", "vm", "gke"],
    roles: ["roles/compute.viewer"],
  },
  {
    id: "compute-net-create",
    permission: "compute.networks.create",
    label: "Create VPC networks",
    modes: ["vm", "gke"],
    roles: ["roles/compute.networkAdmin"],
  },
  {
    id: "compute-subnet-create",
    permission: "compute.subnetworks.create",
    label: "Create subnets",
    modes: ["vm", "gke"],
    roles: ["roles/compute.networkAdmin"],
  },
  {
    id: "compute-fw-create",
    permission: "compute.firewalls.create",
    label: "Create firewall rules",
    modes: ["vm", "gke"],
    // networkAdmin covers firewall create/delete for Terraform VPC rules
    roles: ["roles/compute.networkAdmin"],
  },
  {
    id: "compute-inst-create",
    permission: "compute.instances.create",
    label: "Create Compute Engine VMs",
    modes: ["vm", "gke"],
    roles: ["roles/compute.instanceAdmin.v1"],
  },
  {
    id: "compute-disk-create",
    permission: "compute.disks.create",
    label: "Create disks / Local SSDs",
    modes: ["vm", "gke"],
    // instanceAdmin.v1 includes disk create used by VMs / node pools
    roles: ["roles/compute.instanceAdmin.v1"],
  },
  {
    id: "dns-zones-get",
    permission: "dns.managedZones.get",
    label: "Read Cloud DNS zones",
    modes: ["vm"],
    roles: ["roles/dns.reader"],
  },
  {
    id: "dns-rr-create",
    permission: "dns.resourceRecordSets.create",
    label: "Create DNS records",
    modes: ["vm"],
    // No narrower public predefined role for RR write; dns.admin is the stock minimum
    roles: ["roles/dns.admin"],
  },
  {
    id: "gke-get",
    permission: "container.clusters.get",
    label: "Read GKE clusters",
    modes: ["gke"],
    roles: ["roles/container.clusterViewer"],
  },
  {
    id: "gke-create",
    permission: "container.clusters.create",
    label: "Create GKE clusters",
    modes: ["gke"],
    roles: ["roles/container.clusterAdmin"],
  },
  {
    id: "sa-actas",
    permission: "iam.serviceAccounts.actAs",
    label: "Act as service accounts (GKE nodes)",
    modes: ["gke"],
    roles: ["roles/iam.serviceAccountUser"],
  },
];

/** Least-privilege stock role sets for create (VM / GKE). No project-wide Owner/Editor/compute.admin. */
export const ROLE_SETS = {
  shared: ["roles/browser", "roles/serviceusage.serviceUsageConsumer", "roles/compute.viewer"] as const,
  vm: [
    "roles/browser",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/compute.viewer",
    "roles/compute.networkAdmin",
    "roles/compute.instanceAdmin.v1",
    "roles/dns.admin",
  ] as const,
  gke: [
    "roles/browser",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/compute.viewer",
    "roles/compute.networkAdmin",
    "roles/compute.instanceAdmin.v1",
    "roles/container.clusterAdmin",
    "roles/iam.serviceAccountUser",
  ] as const,
};

const ROLE_ORDER = [
  "roles/browser",
  "roles/serviceusage.serviceUsageConsumer",
  "roles/compute.viewer",
  "roles/compute.networkAdmin",
  "roles/compute.instanceAdmin.v1",
  "roles/dns.reader",
  "roles/dns.admin",
  "roles/container.clusterViewer",
  "roles/container.clusterAdmin",
  "roles/iam.serviceAccountUser",
];

/** dns.reader is redundant when dns.admin is already required for create. */
const ROLE_SUPERSEDES: Record<string, string[]> = {
  "roles/dns.admin": ["roles/dns.reader"],
  "roles/container.clusterAdmin": ["roles/container.clusterViewer"],
};

export function parseServiceAccountJson(jsonText: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Not valid JSON — paste the full service account key file");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON must be an object");
  }
  const key = parsed as ServiceAccountKey;
  if (key.type !== "service_account") {
    throw new Error('Key type must be "service_account" (user OAuth keys are not supported)');
  }
  if (!key.client_email || !key.private_key || !key.project_id) {
    throw new Error("JSON is missing client_email, private_key, or project_id");
  }
  return key;
}

export function guideForPermission(
  permission: string,
  projectId = "PROJECT_ID",
  member = "SERVICE_ACCOUNT_EMAIL",
): string {
  const spec = REQUIRED_PERMISSIONS.find((p) => p.permission === permission);
  const role = spec?.roles[0] || "roles/browser";

  // actAs must be bound on the node SA, not project-wide (zero-trust / least privilege).
  if (permission === "iam.serviceAccounts.actAs") {
    return (
      `Grant roles/iam.serviceAccountUser on the GKE node service account only ` +
      `(default Compute Engine SA), not project-wide:\n` +
      `# resolve project number once:\n` +
      `# gcloud projects describe ${projectId} --format='value(projectNumber)'\n` +
      `gcloud iam service-accounts add-iam-policy-binding \\\n` +
      `  PROJECT_NUMBER-compute@developer.gserviceaccount.com \\\n` +
      `  --project="${projectId}" \\\n` +
      `  --member="serviceAccount:${member}" \\\n` +
      `  --role="roles/iam.serviceAccountUser"\n` +
      `(If you use a custom node SA, bind on that SA instead.)`
    );
  }

  return (
    `Grant ${role} (least privilege for this create-time permission) on the project:\n` +
    `gcloud projects add-iam-policy-binding ${projectId} \\\n` +
    `  --member="serviceAccount:${member}" \\\n` +
    `  --role="${role}"`
  );
}

export function buildPermissionReport(
  granted: Set<string>,
  opts?: { projectId?: string; clientEmail?: string },
): PermissionReport {
  const projectId = opts?.projectId || "PROJECT_ID";
  const member = opts?.clientEmail || "SERVICE_ACCOUNT_EMAIL";

  const checks: PermissionCheck[] = REQUIRED_PERMISSIONS.map((spec) => {
    const ok = granted.has(spec.permission);
    return {
      id: spec.id,
      label: spec.label,
      level: ok ? ("pass" as const) : ("fail" as const),
      detail: ok ? `${spec.permission} granted` : `${spec.permission} missing`,
      guide: ok ? undefined : guideForPermission(spec.permission, projectId, member),
      permission: spec.permission,
      modes: spec.modes,
    };
  });

  const missingFor = (mode: "vm" | "gke") =>
    REQUIRED_PERMISSIONS.filter(
      (p) => (p.modes.includes(mode) || p.modes.includes("shared")) && !granted.has(p.permission),
    ).map((p) => p.permission);

  const vmMissing = missingFor("vm");
  const gkeMissing = missingFor("gke");

  return {
    checks,
    modes: {
      vm: { ok: vmMissing.length === 0, missing: vmMissing },
      gke: { ok: gkeMissing.length === 0, missing: gkeMissing },
    },
  };
}

export function recommendedRoles(missing: string[]): string[] {
  const roles = new Set<string>();
  for (const perm of missing) {
    const spec = REQUIRED_PERMISSIONS.find((p) => p.permission === perm);
    if (spec?.roles[0]) roles.add(spec.roles[0]);
  }

  // Drop roles already covered by a stronger create role in the same family.
  for (const [strong, weakList] of Object.entries(ROLE_SUPERSEDES)) {
    if (roles.has(strong)) {
      for (const weak of weakList) roles.delete(weak);
    }
  }

  return [...roles].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function roleGrantBlock(projectId: string, clientEmail: string, roles: string[]): string {
  return roles
    .map((role) => {
      if (role === "roles/iam.serviceAccountUser") {
        return guideForPermission("iam.serviceAccounts.actAs", projectId, clientEmail);
      }
      return (
        `gcloud projects add-iam-policy-binding ${projectId} \\\n` +
        `  --member="serviceAccount:${clientEmail}" \\\n` +
        `  --role="${role}"`
      );
    })
    .join("\n\n");
}

export async function verifyCredentialFile(absPath: string): Promise<CredentialVerifyResult> {
  const key = readKey(absPath);
  const clientEmail = key.client_email || "";
  const projectId = key.project_id || "";

  const base: CredentialVerifyResult = {
    ok: false,
    jsonValid: true,
    authOk: false,
    clientEmail,
    projectId,
    checks: [],
    modes: { vm: { ok: false, missing: [] }, gke: { ok: false, missing: [] } },
    recommended: [],
  };

  if (key.type !== "service_account" || !clientEmail || !key.private_key || !projectId) {
    return {
      ...base,
      jsonValid: false,
      checks: [
        {
          id: "json",
          label: "Service account JSON",
          level: "fail",
          detail: "Missing type=service_account, client_email, private_key, or project_id",
          guide: "Download a new key from IAM → Service Accounts → Keys → Add key → JSON",
          modes: ["shared", "vm", "gke"],
        },
      ],
    };
  }

  let projectName: string | undefined;
  try {
    const info = await getProject(absPath, projectId);
    projectName = info.name;
    base.authOk = true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const hint = iamHint(detail);
    return {
      ...base,
      checks: [
        {
          id: "auth",
          label: "Authenticate to GCP",
          level: "fail",
          detail,
          guide:
            hint ||
            `Confirm the key is enabled and has access to project ${projectId}. ` +
              `gcloud auth activate-service-account --key-file=KEY.json`,
          modes: ["shared", "vm", "gke"],
        },
      ],
    };
  }

  let granted: string[] = [];
  try {
    granted = await testIamPermissions(
      absPath,
      projectId,
      REQUIRED_PERMISSIONS.map((p) => p.permission),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = err instanceof GcpApiError ? err.status : 0;
    return {
      ...base,
      authOk: true,
      projectName,
      checks: [
        {
          id: "iam-test",
          label: "Test IAM permissions",
          level: "fail",
          detail: `${detail}${status ? ` (HTTP ${status})` : ""}`,
          guide:
            iamHint(detail) ||
            `The SA needs permission to call testIamPermissions. ` +
              `Grant roles/browser, then re-run verify.`,
          modes: ["shared", "vm", "gke"],
        },
      ],
    };
  }

  const report = buildPermissionReport(new Set(granted), { projectId, clientEmail });
  const allMissing = [...new Set([...report.modes.vm.missing, ...report.modes.gke.missing])];
  const recommended = recommendedRoles(allMissing);

  const summaryChecks: PermissionCheck[] = [
    {
      id: "json",
      label: "Service account JSON",
      level: "pass",
      detail: clientEmail,
      modes: ["shared", "vm", "gke"],
    },
    {
      id: "auth",
      label: "Authenticate to GCP",
      level: "pass",
      detail: projectName ? `${projectName} (${projectId})` : projectId,
      modes: ["shared", "vm", "gke"],
    },
    {
      id: "mode-vm",
      label: "Ready for VM deployments",
      level: report.modes.vm.ok ? "pass" : "fail",
      detail: report.modes.vm.ok
        ? "All VM / DNS permissions present"
        : `Missing ${report.modes.vm.missing.length} permission(s)`,
      guide: report.modes.vm.ok
        ? undefined
        : `Least-privilege roles for VM create:\n${roleGrantBlock(projectId, clientEmail, recommendedRoles(report.modes.vm.missing))}`,
      modes: ["vm"],
    },
    {
      id: "mode-gke",
      label: "Ready for GKE deployments",
      level: report.modes.gke.ok ? "pass" : "fail",
      detail: report.modes.gke.ok
        ? "All GKE permissions present"
        : `Missing ${report.modes.gke.missing.length} permission(s)`,
      guide: report.modes.gke.ok
        ? undefined
        : `Least-privilege roles for GKE create:\n${roleGrantBlock(projectId, clientEmail, recommendedRoles(report.modes.gke.missing))}`,
      modes: ["gke"],
    },
    ...report.checks,
  ];

  return {
    ok: report.modes.vm.ok || report.modes.gke.ok,
    jsonValid: true,
    authOk: true,
    clientEmail,
    projectId,
    projectName,
    checks: summaryChecks,
    modes: report.modes,
    recommended,
  };
}

export async function verifyCredentialJson(jsonText: string): Promise<CredentialVerifyResult> {
  const key = parseServiceAccountJson(jsonText);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rew-cred-"));
  const abs = path.join(dir, "key.json");
  try {
    fs.writeFileSync(abs, JSON.stringify(key), { mode: 0o600 });
    return await verifyCredentialFile(abs);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
