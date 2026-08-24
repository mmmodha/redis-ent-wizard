import path from "node:path";
import fs from "node:fs";
import type { AuthUser } from "./auth.js";
import { getOwnedArtifact } from "./artifacts-store.js";
import { downloadObject } from "./gcp.js";
import type { Application, CreateInstanceInput, DeploymentMode } from "./types.js";

export const MAX_APPLICATIONS = 8;
const MAX_APP_VMS = 10;
const MAX_REPLICAS = 20;
const MAX_APP_PORTS = 16;
const DEFAULT_APP_MACHINE = "e2-standard-2";
const RESERVED_APP_NAMES = new Set(["app", "gke", "rec", "cluster", "node"]);

export function normalizeApplicationName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("Application name is required");
  if (!/^[a-z]/.test(slug)) throw new Error("Application names must start with a letter");
  if (RESERVED_APP_NAMES.has(slug)) throw new Error(`Application name "${slug}" is reserved`);
  return slug;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizePorts(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of list) {
    const n = Math.floor(Number(p));
    if (!Number.isInteger(n) || n < 1 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_APP_PORTS) break;
  }
  return out;
}

function normalizeEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(k).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      out[key] = String(v ?? "");
    }
  }
  return out;
}

/** Validate + clamp the applications list for a deployment. Pure (no I/O). */
export function normalizeApplications(input: {
  mode?: DeploymentMode;
  applications?: Application[];
}): Application[] {
  const mode = input.mode || "vm";
  const listed = input.applications || [];
  if (listed.length > MAX_APPLICATIONS) {
    throw new Error(`A deployment can have at most ${MAX_APPLICATIONS} applications`);
  }

  const seen = new Set<string>();
  return listed.map((raw) => {
    const name = normalizeApplicationName(raw.name);
    if (seen.has(name)) throw new Error(`Application names must be unique (${name})`);
    seen.add(name);

    const command = String(raw.command ?? "").trim();
    const ports = normalizePorts(raw.ports);
    const env = normalizeEnv(raw.env);
    const requirements = Array.isArray(raw.requirements)
      ? raw.requirements.map((r) => String(r).trim()).filter(Boolean).slice(0, 20)
      : [];
    const connectClusters = Array.isArray(raw.connectClusters)
      ? raw.connectClusters.map((c) => String(c)).filter(Boolean)
      : [];

    if (mode === "vm") {
      if (!raw.artifact || !raw.artifact.ref) {
        throw new Error(`Application "${name}" needs an artifact (upload, url, or gcs)`);
      }
      const kind = raw.artifact.kind;
      if (kind !== "upload" && kind !== "url" && kind !== "gcs") {
        throw new Error(`Application "${name}" has an invalid artifact kind`);
      }
      if (kind === "url" && !/^https?:\/\//i.test(raw.artifact.ref)) {
        throw new Error(`Application "${name}" url artifact must be http(s)`);
      }
      if (kind === "gcs" && !raw.artifact.ref.startsWith("gs://")) {
        throw new Error(`Application "${name}" gcs artifact must start with gs://`);
      }
      return {
        name,
        command,
        ports,
        env,
        connectClusters,
        artifact: {
          kind,
          ref: String(raw.artifact.ref),
          type: raw.artifact.type === "jar" ? "jar" : "binary",
        },
        vm_count: clampInt(raw.vm_count, 1, MAX_APP_VMS, 1),
        machine_type: String(raw.machine_type || DEFAULT_APP_MACHINE).trim() || DEFAULT_APP_MACHINE,
        disk_gib: clampInt(raw.disk_gib, 0, 65536, 0),
        requirements,
        // Preserve already-resolved artifact fields so re-normalization is idempotent.
        artifactLocalPath: raw.artifactLocalPath,
        artifactFilename: raw.artifactFilename,
      } satisfies Application;
    }

    // GKE
    if (!raw.image || !String(raw.image).trim()) {
      throw new Error(`Application "${name}" needs a container image`);
    }
    return {
      name,
      command,
      ports,
      env,
      connectClusters,
      image: String(raw.image).trim(),
      replicas: clampInt(raw.replicas, 1, MAX_REPLICAS, 1),
      expose: raw.expose === "lb" || raw.expose === "http" || raw.expose === "https" ? raw.expose : "none",
    } satisfies Application;
  });
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base || fallback;
  } catch {
    return fallback;
  }
}

function parseGsUri(ref: string): { bucket: string; object: string } {
  const rest = ref.slice("gs://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) throw new Error(`Invalid gs:// URI: ${ref}`);
  return { bucket: rest.slice(0, slash), object: rest.slice(slash + 1) };
}

function stagingDir(input: CreateInstanceInput, appName: string): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
  const dir = path.join(dataDir, "artifacts", "staging", `${input.name}-${input.env || "default"}`, appName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve each VM application's artifact to a LOCAL file path that Terraform
 * copies onto the VM over SSH. Uploads use the stored blob directly; https and
 * gs:// artifacts are downloaded by the API into a staging dir. Mutates the
 * applications in place with `artifactLocalPath` / `artifactFilename`.
 */
export async function resolveApplicationArtifacts(
  input: CreateInstanceInput,
  ctx: { user: AuthUser; credentialsFile: string; project: string },
): Promise<Application[]> {
  const apps = input.applications || [];
  if (input.mode !== "vm") return apps; // GKE uses container images, no artifact fetch

  for (const app of apps) {
    if (!app.artifact) continue;
    const { kind, ref, type } = app.artifact;

    if (kind === "upload") {
      // Copy the stored blob into the staging dir under its real filename so the
      // SSH file provisioner lands it with a sensible name on the VM.
      const { absPath, meta } = getOwnedArtifact(ctx.user, ref);
      const dest = path.join(stagingDir(input, app.name), meta.filename);
      fs.copyFileSync(absPath, dest);
      app.artifactLocalPath = dest;
      app.artifactFilename = meta.filename;
      app.artifact.type = meta.type;
      continue;
    }

    if (kind === "url") {
      const filename = filenameFromUrl(ref, type === "jar" ? "app.jar" : "app");
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`Could not download artifact ${ref}: HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const dest = path.join(stagingDir(input, app.name), filename);
      fs.writeFileSync(dest, new Uint8Array(data));
      app.artifactLocalPath = dest;
      app.artifactFilename = filename;
      continue;
    }

    // gcs: download the object (needs storage.objects.get)
    const { bucket, object } = parseGsUri(ref);
    const filename = path.basename(object) || (type === "jar" ? "app.jar" : "app");
    const data = await downloadObject(ctx.credentialsFile, bucket, object);
    const dest = path.join(stagingDir(input, app.name), filename);
    fs.writeFileSync(dest, new Uint8Array(data));
    app.artifactLocalPath = dest;
    app.artifactFilename = filename;
  }
  return apps;
}
