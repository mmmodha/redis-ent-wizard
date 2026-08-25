import { resolveApiBase } from "./api-base";

function apiBase(): string {
  return resolveApiBase({
    isBrowser: typeof window !== "undefined",
    publicUrl: process.env.NEXT_PUBLIC_API_URL,
    internalUrl: process.env.API_INTERNAL_URL,
  });
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = { ...(extra as Record<string, string>) };
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("rew-access-token");
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export type ProgressStep = {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "failed";
  detail?: string;
};

export type ResourceSection = {
  id: string;
  label: string;
  total: number;
  done: number;
  state: "pending" | "active" | "done" | "failed";
  current?: string;
};

export type Progress = {
  operation?: "apply" | "destroy";
  phase: string;
  phaseLabel: string;
  percent: number;
  resourcesDone: number;
  resourcesTotal: number;
  currentResource?: string;
  steps: ProgressStep[];
  sections?: ResourceSection[];
  elapsedSeconds?: number;
};

export type ClusterHealth = {
  state: "installing" | "bootstrapping" | "ready" | "unknown";
  nodesActive: number;
  nodesExpected: number;
  uiReachable: boolean;
  checkedAt: string;
  detail: string;
};

export type DatabaseState = {
  cluster: string;
  name: string;
  status: "pending" | "creating" | "active" | "failed";
  uid?: number;
  endpoint?: string;
  port?: number;
  error?: string;
};

export type LicenseState = {
  cluster: string;
  status: "applied" | "failed";
  detail?: string;
  error?: string;
};

export type Instance = {
  id: string;
  name: string;
  mode: "vm" | "gke";
  status: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  region: string;
  ownerEmail: string;
  credentialsId?: string;
  credentialsFile?: string;
  folder?: string;
  busy?: boolean;
  endpoints?: Record<string, unknown>;
  lastError?: string;
  config?: Record<string, unknown>;
  progress?: Progress;
  health?: ClusterHealth;
  databaseStates?: DatabaseState[];
  licenseStates?: LicenseState[];
};

export type FolderInfo = { folder: string; count: number };
export type OwnerInfo = { owner: string; count: number };
export type BulkDestroyResult = {
  ok: boolean;
  started: string[];
  skipped: { id: string; reason: string }[];
};

export type Credential = {
  id?: string;
  file: string;
  name?: string;
  projectId: string;
  clientEmail: string;
  valid: boolean;
  error?: string;
  source?: "user" | "shared";
};

export type ProjectInfo = { projectId: string; name: string };

export type RegionInfo = {
  name: string;
  status: string;
  zones: string[];
  zoneSuffixes: string[];
};

export type MachineTypeInfo = {
  name: string;
  guestCpus: number;
  memoryMb: number;
  description: string;
  maxLocalSsds?: number;
  architecture?: string;
};

export type DnsZoneInfo = { name: string; dnsName: string; visibility?: string };

export type CheckResult = {
  id: string;
  label: string;
  level: "pass" | "warn" | "fail";
  detail: string;
  guide?: string;
};

export type CredentialVerifyResult = {
  ok: boolean;
  jsonValid: boolean;
  authOk: boolean;
  clientEmail: string;
  projectId: string;
  projectName?: string;
  checks: CheckResult[];
  modes: {
    vm: { ok: boolean; missing: string[] };
    gke: { ok: boolean; missing: string[] };
  };
  recommended: string[];
};

export type PreflightResult = {
  ok: boolean;
  instanceId: string;
  checks: CheckResult[];
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { error?: unknown; hint?: string; details?: string[] };
    const err = body.error;
    const hint = body.hint;
    const details = body.details?.join("; ");
    const msg =
      typeof err === "string"
        ? err
        : JSON.stringify(err ?? res.statusText);
    throw new Error([msg, details, hint].filter(Boolean).join(" — "));
  }
  return data as T;
}

export async function listInstances(): Promise<Instance[]> {
  return jsonOrThrow(await fetch(`${apiBase()}/instances`, { cache: "no-store", headers: authHeaders() }));
}

export async function getInstance(id: string): Promise<Instance> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}`, {
      cache: "no-store",
      headers: authHeaders(),
    }),
  );
}

export async function createInstance(body: Record<string, unknown>): Promise<Instance> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/instances`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

export async function destroyInstance(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

export type RsReleaseInfo = { id: string; label: string; url: string };
export type GkeOperatorInfo = { id: string; label: string; chartVersion: string };

export async function listReleases(): Promise<{ vm: RsReleaseInfo[]; gke: GkeOperatorInfo[] }> {
  return jsonOrThrow(await fetch(`${apiBase()}/releases`, { cache: "no-store", headers: authHeaders() }));
}

export async function retryInstance(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      headers: authHeaders(),
    }),
  );
}

export async function recreateInstance(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}/recreate`, {
      method: "POST",
      headers: authHeaders(),
    }),
  );
}

export async function recheckHealth(id: string): Promise<ClusterHealth> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}/health`, {
      method: "POST",
      headers: authHeaders(),
    }),
  ) as Promise<ClusterHealth>;
}

export async function forgetInstance(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}/forget`, {
      method: "POST",
      headers: authHeaders(),
    }),
  );
}

export async function bulkDestroy(ids: string[]): Promise<BulkDestroyResult> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/instances/bulk-destroy`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ids }),
    }),
  );
}

export async function moveInstance(id: string, folder: string | null): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ folder }),
    }),
  );
}

export async function listFolders(): Promise<FolderInfo[]> {
  return jsonOrThrow(await fetch(`${apiBase()}/folders`, { cache: "no-store", headers: authHeaders() }));
}

export async function listOwners(): Promise<OwnerInfo[]> {
  return jsonOrThrow(await fetch(`${apiBase()}/owners`, { cache: "no-store", headers: authHeaders() }));
}

export async function listCredentials(): Promise<Credential[]> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/credentials`, { cache: "no-store", headers: authHeaders() }),
  );
}

export async function uploadCredential(name: string, json: string): Promise<Credential> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/credentials`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, json }),
    }),
  );
}

export async function deleteCredential(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/credentials/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

export async function verifyCredential(input: {
  credentialsFile?: string;
  json?: string;
}): Promise<CredentialVerifyResult> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/credentials/verify`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }),
  );
}

export async function listProjects(credentialsFile: string): Promise<ProjectInfo[]> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/gcp/projects?credentialsFile=${encodeURIComponent(credentialsFile)}`, {
      cache: "no-store",
      headers: authHeaders(),
    }),
  );
}

export async function listRegions(
  credentialsFile: string,
  project: string,
): Promise<RegionInfo[]> {
  const qs = new URLSearchParams({ credentialsFile, project });
  return jsonOrThrow(
    await fetch(`${apiBase()}/gcp/regions?${qs}`, { cache: "no-store", headers: authHeaders() }),
  );
}

export async function listMachineTypes(
  credentialsFile: string,
  project: string,
  zone: string,
): Promise<MachineTypeInfo[]> {
  const qs = new URLSearchParams({ credentialsFile, project, zone });
  return jsonOrThrow(
    await fetch(`${apiBase()}/gcp/machine-types?${qs}`, {
      cache: "no-store",
      headers: authHeaders(),
    }),
  );
}

export async function listDnsZones(
  credentialsFile: string,
  project: string,
): Promise<DnsZoneInfo[]> {
  const qs = new URLSearchParams({ credentialsFile, project });
  return jsonOrThrow(
    await fetch(`${apiBase()}/gcp/dns-zones?${qs}`, { cache: "no-store", headers: authHeaders() }),
  );
}

export async function reconcileDatabases(
  id: string,
  body?: { clusters?: Array<{ name?: string; databases: Record<string, unknown>[] }> },
): Promise<{ ok: boolean; databaseStates: DatabaseState[]; licenseStates: LicenseState[] }> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/instances/${encodeURIComponent(id)}/databases/reconcile`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body ?? {}),
    }),
  );
}

export async function runPreflight(body: Record<string, unknown>): Promise<PreflightResult> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/preflight`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

export type Artifact = {
  id: string;
  name: string;
  filename: string;
  size: number;
  type: "jar" | "binary";
};

export async function listArtifacts(): Promise<Artifact[]> {
  return jsonOrThrow(
    await fetch(`${apiBase()}/artifacts`, { cache: "no-store", headers: authHeaders() }),
  );
}

export async function uploadArtifact(file: File): Promise<Artifact> {
  const form = new FormData();
  form.append("file", file);
  return jsonOrThrow(
    await fetch(`${apiBase()}/artifacts`, {
      method: "POST",
      // Let the browser set the multipart boundary; only auth is added here.
      headers: authHeaders(),
      body: form,
    }),
  );
}

export async function deleteArtifact(id: string): Promise<void> {
  await jsonOrThrow(
    await fetch(`${apiBase()}/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

export { apiBase };
