import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "./auth.js";
import { authDisabled } from "./auth.js";
import {
  dbDeleteCredential,
  dbGetCredentialBlob,
  dbListCredentialsMeta,
  dbUpsertCredential,
  type CredentialRow,
} from "./db.js";
import { listCredentials as listLegacySharedCredentials, type CredentialSummary, type ServiceAccountKey } from "./gcp.js";

function encryptionKey(): Buffer {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.SESSION_SECRET || "dev-only-change-me-please-32b!";
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export type UserCredentialSummary = {
  id: string;
  name: string;
  file: string; // alias for wizard compatibility (id or legacy filename)
  projectId: string;
  clientEmail: string;
  valid: boolean;
  ownerEmail?: string;
  source: "user" | "shared";
};

function materializePath(ownerSub: string, id: string): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
  const dir = path.join(dataDir, "credentials-runtime", ownerSub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${id}.json`);
}

export async function listUserCredentials(user: AuthUser): Promise<UserCredentialSummary[]> {
  const owned = await dbListCredentialsMeta(user.role === "admin" && authDisabled() ? undefined : user.sub);
  const mine =
    user.role === "admin" && !authDisabled()
      ? owned.filter((c) => c.ownerSub === user.sub)
      : user.role === "admin" && authDisabled()
        ? owned
        : owned.filter((c) => c.ownerSub === user.sub);

  const userCreds: UserCredentialSummary[] = mine.map((c) => ({
    id: c.id,
    name: c.name,
    file: c.id,
    projectId: c.projectId,
    clientEmail: c.clientEmail,
    valid: true,
    ownerEmail: c.ownerEmail,
    source: "user",
  }));

  // Shared folder only when auth is disabled (single-operator Compose).
  if (authDisabled()) {
    const shared = listLegacySharedCredentials().map((c: CredentialSummary) => ({
      id: `shared:${c.file}`,
      name: c.file,
      file: c.file,
      projectId: c.projectId,
      clientEmail: c.clientEmail,
      valid: c.valid,
      source: "shared" as const,
      error: c.error,
    }));
    return [...userCreds, ...shared];
  }

  return userCreds;
}

export async function uploadUserCredential(
  user: AuthUser,
  name: string,
  jsonText: string,
): Promise<UserCredentialSummary> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(jsonText) as ServiceAccountKey;
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw Object.assign(new Error("Not a valid GCP service account key"), { statusCode: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta: CredentialRow = {
    id,
    ownerSub: user.sub,
    ownerEmail: user.email,
    name: name.trim().slice(0, 80) || key.client_email,
    clientEmail: key.client_email,
    projectId: key.project_id || "",
    createdAt: now,
    updatedAt: now,
  };
  await dbUpsertCredential(meta, encrypt(jsonText));
  // Materialize for Terraform immediately.
  const abs = materializePath(user.sub, id);
  fs.writeFileSync(abs, jsonText, { mode: 0o600 });

  return {
    id,
    name: meta.name,
    file: id,
    projectId: meta.projectId,
    clientEmail: meta.clientEmail,
    valid: true,
    ownerEmail: meta.ownerEmail,
    source: "user",
  };
}

export async function deleteUserCredential(user: AuthUser, id: string, forceAdmin = false): Promise<void> {
  const row = await dbGetCredentialBlob(id);
  if (!row) throw Object.assign(new Error("Credential not found"), { statusCode: 404 });
  if (row.meta.ownerSub !== user.sub && !(forceAdmin && user.role === "admin")) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  await dbDeleteCredential(id);
  const abs = materializePath(row.meta.ownerSub, id);
  fs.rmSync(abs, { force: true });
}

/** Resolve a credentialsFile value (user id or legacy filename) to an absolute path the caller may use. */
export async function resolveOwnedCredentialsPath(
  user: AuthUser,
  credentialsFile: string,
): Promise<{ absPath: string; credentialsId?: string }> {
  if (credentialsFile.startsWith("shared:")) {
    if (!authDisabled()) {
      throw Object.assign(new Error("Shared credentials are only available when AUTH_DISABLED=true"), {
        statusCode: 403,
      });
    }
    credentialsFile = credentialsFile.slice("shared:".length);
  }

  // Legacy shared filename
  if (credentialsFile.endsWith(".json") && !credentialsFile.includes("/")) {
    if (!authDisabled() && user.role !== "admin") {
      // Allow only if this looks like a user upload id mistaken — check DB first
    } else if (authDisabled()) {
      const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
      const abs = path.join(dataDir, "credentials", credentialsFile);
      if (fs.existsSync(abs)) return { absPath: abs };
    }
  }

  const row = await dbGetCredentialBlob(credentialsFile);
  if (row) {
    if (row.meta.ownerSub !== user.sub && user.role !== "admin") {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
    const plain = decrypt(row.encBlob);
    const abs = materializePath(row.meta.ownerSub, row.meta.id);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, plain, { mode: 0o600 });
    return { absPath: abs, credentialsId: row.meta.id };
  }

  // AUTH_DISABLED shared folder fallback
  if (authDisabled()) {
    const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
    const abs = path.isAbsolute(credentialsFile)
      ? credentialsFile
      : path.join(dataDir, "credentials", credentialsFile);
    if (fs.existsSync(abs)) return { absPath: abs };
  }

  throw Object.assign(new Error(`Credentials not found: ${credentialsFile}`), { statusCode: 404 });
}
