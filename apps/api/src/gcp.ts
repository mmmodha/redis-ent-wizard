import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { maxLocalSsdsForMachineType } from "./nvme.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ServiceAccountKey {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export interface CredentialSummary {
  file: string;
  projectId: string;
  clientEmail: string;
  valid: boolean;
  error?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export function credentialsDir(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
  const dir = path.join(dataDir, "credentials");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listCredentials(): CredentialSummary[] {
  const dir = credentialsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        const key = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ServiceAccountKey;
        const valid =
          key.type === "service_account" && Boolean(key.client_email) && Boolean(key.private_key);
        return {
          file,
          projectId: key.project_id || "",
          clientEmail: key.client_email || "",
          valid,
          error: valid ? undefined : "Not a valid service account key",
        };
      } catch (err) {
        return {
          file,
          projectId: "",
          clientEmail: "",
          valid: false,
          error: err instanceof Error ? err.message : "Unreadable JSON",
        };
      }
    });
}

export function readKey(credentialsFile: string): ServiceAccountKey {
  const abs = path.isAbsolute(credentialsFile)
    ? credentialsFile
    : path.join(credentialsDir(), credentialsFile);
  if (!fs.existsSync(abs)) {
    throw new Error(`Credentials file not found: ${credentialsFile}`);
  }
  return JSON.parse(fs.readFileSync(abs, "utf8")) as ServiceAccountKey;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function fetchAccessToken(credentialsFile: string): Promise<string> {
  const cached = tokenCache.get(credentialsFile);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const key = readKey(credentialsFile);
  if (!key.client_email || !key.private_key) {
    throw new Error("Service account key is missing client_email or private_key");
  }

  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = base64url(
    crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key.private_key),
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${payload}.${signature}`,
    }),
  });

  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Auth failed: ${body.error_description || res.statusText}`);
  }

  tokenCache.set(credentialsFile, {
    token: body.access_token,
    expiresAt: now + 3500_000,
  });
  return body.access_token;
}

export class GcpApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function gcpGet<T>(credentialsFile: string, url: string): Promise<T> {
  return gcpRequest<T>(credentialsFile, url, { method: "GET" });
}

async function gcpRequest<T>(
  credentialsFile: string,
  url: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const token = await fetchAccessToken(credentialsFile);
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message || detail;
    } catch {
      // keep statusText
    }
    throw new GcpApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Which of the requested IAM permissions the SA currently has on the project. */
export async function testIamPermissions(
  credentialsFile: string,
  project: string,
  permissions: string[],
): Promise<string[]> {
  if (!permissions.length) return [];
  const body = await gcpRequest<{ permissions?: string[] }>(
    credentialsFile,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}:testIamPermissions`,
    { method: "POST", body: { permissions } },
  );
  return body.permissions || [];
}

async function gcpGetAll<T>(
  credentialsFile: string,
  url: string,
  itemsKey = "items",
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const paged = pageToken ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}` : url;
    const body = await gcpGet<Record<string, unknown>>(credentialsFile, paged);
    const items = (body[itemsKey] as T[] | undefined) || [];
    out.push(...items);
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return out;
}

export interface ProjectInfo {
  projectId: string;
  name: string;
  lifecycleState?: string;
}

export async function listProjects(credentialsFile: string): Promise<ProjectInfo[]> {
  const projects = await gcpGetAll<{
    projectId: string;
    name: string;
    lifecycleState?: string;
  }>(credentialsFile, "https://cloudresourcemanager.googleapis.com/v1/projects", "projects");

  const active = projects
    .filter((p) => !p.lifecycleState || p.lifecycleState === "ACTIVE")
    .map((p) => ({ projectId: p.projectId, name: p.name, lifecycleState: p.lifecycleState }));

  if (active.length) return active;

  // Service accounts often lack list permission; fall back to the key's own project
  const key = readKey(credentialsFile);
  if (key.project_id) {
    const p = await getProject(credentialsFile, key.project_id);
    return [p];
  }
  return [];
}

export async function getProject(
  credentialsFile: string,
  projectId: string,
): Promise<ProjectInfo> {
  const p = await gcpGet<{ projectId: string; name: string; lifecycleState?: string }>(
    credentialsFile,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
  );
  return { projectId: p.projectId, name: p.name, lifecycleState: p.lifecycleState };
}

export interface RegionInfo {
  name: string;
  status: string;
  zones: string[];
  zoneSuffixes: string[];
}

export interface QuotaInfo {
  metric: string;
  limit: number;
  usage: number;
}

export async function listRegions(credentialsFile: string, project: string): Promise<RegionInfo[]> {
  const regions = await gcpGetAll<{
    name: string;
    status: string;
    zones?: string[];
  }>(credentialsFile, `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/regions`);

  return regions
    .filter((r) => r.status === "UP")
    .map((r) => {
      const zones = (r.zones || []).map((z) => z.split("/").pop() || "");
      return {
        name: r.name,
        status: r.status,
        zones,
        zoneSuffixes: zones.map((z) => z.replace(`${r.name}-`, "")).sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRegion(
  credentialsFile: string,
  project: string,
  region: string,
): Promise<RegionInfo & { quotas: QuotaInfo[] }> {
  const r = await gcpGet<{
    name: string;
    status: string;
    zones?: string[];
    quotas?: { metric: string; limit: number; usage: number }[];
  }>(
    credentialsFile,
    `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/regions/${encodeURIComponent(region)}`,
  );
  const zones = (r.zones || []).map((z) => z.split("/").pop() || "");
  return {
    name: r.name,
    status: r.status,
    zones,
    zoneSuffixes: zones.map((z) => z.replace(`${r.name}-`, "")).sort(),
    quotas: r.quotas || [],
  };
}

export interface MachineTypeInfo {
  name: string;
  guestCpus: number;
  memoryMb: number;
  description: string;
  deprecated: boolean;
  /** Max Local SSD / NVMe scratch disks this machine type can attach (approx). */
  maxLocalSsds: number;
  /** "X86_64" or "ARM64" — our boot images are x86 only. */
  architecture: string;
}

export async function listMachineTypes(
  credentialsFile: string,
  project: string,
  zone: string,
): Promise<MachineTypeInfo[]> {
  const types = await gcpGetAll<{
    name: string;
    guestCpus: number;
    memoryMb: number;
    description: string;
    deprecated?: { state?: string };
    architecture?: string;
  }>(
    credentialsFile,
    `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/machineTypes`,
  );

  return types
    .map((t) => ({
      name: t.name,
      guestCpus: t.guestCpus,
      memoryMb: t.memoryMb,
      description: t.description,
      deprecated: Boolean(t.deprecated?.state),
      maxLocalSsds: maxLocalSsdsForMachineType(t.name) ?? 0,
      architecture: t.architecture || "X86_64",
    }))
    // Every VM here boots an amd64 Ubuntu image, so Arm types could never apply.
    .filter((t) => !t.deprecated && t.architecture !== "ARM64")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getMachineType(
  credentialsFile: string,
  project: string,
  zone: string,
  machineType: string,
): Promise<MachineTypeInfo> {
  const t = await gcpGet<{
    name: string;
    guestCpus: number;
    memoryMb: number;
    description: string;
    deprecated?: { state?: string };
    architecture?: string;
  }>(
    credentialsFile,
    `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/machineTypes/${encodeURIComponent(machineType)}`,
  );
  return {
    name: t.name,
    guestCpus: t.guestCpus,
    memoryMb: t.memoryMb,
    description: t.description,
    deprecated: Boolean(t.deprecated?.state),
    maxLocalSsds: maxLocalSsdsForMachineType(t.name) ?? 0,
    architecture: t.architecture || "X86_64",
  };
}

export interface DnsZoneInfo {
  name: string;
  dnsName: string;
  visibility?: string;
}

export async function listDnsZones(
  credentialsFile: string,
  project: string,
): Promise<DnsZoneInfo[]> {
  const zones = await gcpGetAll<{ name: string; dnsName: string; visibility?: string }>(
    credentialsFile,
    `https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(project)}/managedZones`,
    "managedZones",
  );
  return zones.map((z) => ({
    name: z.name,
    dnsName: z.dnsName.replace(/\.$/, ""),
    visibility: z.visibility,
  }));
}

export async function listEnabledServices(
  credentialsFile: string,
  project: string,
): Promise<string[]> {
  const services = await gcpGetAll<{ config?: { name?: string } }>(
    credentialsFile,
    `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}/services?filter=state:ENABLED&pageSize=200`,
    "services",
  );
  return services.map((s) => s.config?.name || "").filter(Boolean);
}

export async function networkExists(
  credentialsFile: string,
  project: string,
  network: string,
): Promise<boolean> {
  try {
    await gcpGet(
      credentialsFile,
      `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/networks/${encodeURIComponent(network)}`,
    );
    return true;
  } catch (err) {
    if (err instanceof GcpApiError && err.status === 404) return false;
    throw err;
  }
}

export async function dnsNameExists(
  credentialsFile: string,
  project: string,
  managedZone: string,
  fqdn: string,
): Promise<boolean> {
  const name = fqdn.endsWith(".") ? fqdn : `${fqdn}.`;
  const data = await gcpGet<{ rrsets?: unknown[] }>(
    credentialsFile,
    `https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(managedZone)}/rrsets?name=${encodeURIComponent(name)}`,
  );
  return (data.rrsets?.length ?? 0) > 0;
}

export async function gkeClusterExists(
  credentialsFile: string,
  project: string,
  location: string,
  cluster: string,
): Promise<boolean> {
  try {
    await gcpGet(
      credentialsFile,
      `https://container.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(cluster)}`,
    );
    return true;
  } catch (err) {
    if (err instanceof GcpApiError && err.status === 404) return false;
    throw err;
  }
}
