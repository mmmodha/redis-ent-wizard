import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "./auth.js";

/**
 * Application artifacts (jars / binaries) uploaded through the designer. Stored
 * per-user on disk under DATA_DIR/artifacts/<ownerSub>/. They are only needed
 * transiently at apply time (staged to GCS and handed to VMs as a signed URL),
 * so a flat file store is enough — no DB row.
 */

export type ArtifactType = "jar" | "binary";

export interface ArtifactMeta {
  id: string;
  ownerSub: string;
  ownerEmail?: string;
  name: string;
  filename: string;
  type: ArtifactType;
  size: number;
  createdAt: string;
}

export interface ArtifactSummary {
  id: string;
  name: string;
  filename: string;
  type: ArtifactType;
  size: number;
  createdAt: string;
}

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024; // 512 MiB

function artifactsRoot(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
  return path.join(dataDir, "artifacts");
}

function ownerDir(ownerSub: string): string {
  const dir = path.join(artifactsRoot(), ownerSub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function metaPath(ownerSub: string, id: string): string {
  return path.join(ownerDir(ownerSub), `${id}.meta.json`);
}

function blobPath(ownerSub: string, id: string): string {
  return path.join(ownerDir(ownerSub), `${id}.bin`);
}

function inferType(filename: string, explicit?: string): ArtifactType {
  if (explicit === "jar" || explicit === "binary") return explicit;
  return filename.toLowerCase().endsWith(".jar") ? "jar" : "binary";
}

function toSummary(m: ArtifactMeta): ArtifactSummary {
  return { id: m.id, name: m.name, filename: m.filename, type: m.type, size: m.size, createdAt: m.createdAt };
}

/** Owner scope: a user sees their own; an admin sees everyone's. */
function ownerScopes(user: AuthUser): string[] {
  const root = artifactsRoot();
  if (!fs.existsSync(root)) return [];
  if (user.role === "admin") return fs.readdirSync(root);
  return [user.sub];
}

export function listUserArtifacts(user: AuthUser): ArtifactSummary[] {
  const out: ArtifactSummary[] = [];
  for (const sub of ownerScopes(user)) {
    const dir = path.join(artifactsRoot(), sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ArtifactMeta;
        out.push(toSummary(meta));
      } catch {
        /* skip unreadable meta */
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveUserArtifact(
  user: AuthUser,
  input: { name?: string; filename: string; type?: string; data: Buffer },
): ArtifactSummary {
  if (!input.filename) throw Object.assign(new Error("filename is required"), { statusCode: 400 });
  if (!input.data?.length) throw Object.assign(new Error("empty artifact"), { statusCode: 400 });
  if (input.data.length > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`), { statusCode: 413 });
  }
  const filename = path.basename(input.filename).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "artifact";
  const id = crypto.randomUUID();
  const meta: ArtifactMeta = {
    id,
    ownerSub: user.sub,
    ownerEmail: user.email,
    name: (input.name || filename).trim().slice(0, 120),
    filename,
    type: inferType(filename, input.type),
    size: input.data.length,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(blobPath(user.sub, id), new Uint8Array(input.data), { mode: 0o600 });
  fs.writeFileSync(metaPath(user.sub, id), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return toSummary(meta);
}

function findMeta(user: AuthUser, id: string): ArtifactMeta | undefined {
  for (const sub of ownerScopes(user)) {
    const p = metaPath(sub, id);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8")) as ArtifactMeta;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Resolve an owned artifact to its on-disk blob path + metadata (ownership enforced). */
export function getOwnedArtifact(user: AuthUser, id: string): { absPath: string; meta: ArtifactMeta } {
  const meta = findMeta(user, id);
  if (!meta) throw Object.assign(new Error(`Artifact not found: ${id}`), { statusCode: 404 });
  if (meta.ownerSub !== user.sub && user.role !== "admin") {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return { absPath: blobPath(meta.ownerSub, id), meta };
}

export function deleteUserArtifact(user: AuthUser, id: string): void {
  const { meta } = getOwnedArtifact(user, id);
  fs.rmSync(blobPath(meta.ownerSub, id), { force: true });
  fs.rmSync(metaPath(meta.ownerSub, id), { force: true });
}
