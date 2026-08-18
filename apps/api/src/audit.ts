import crypto from "node:crypto";
import type { AuthUser } from "./auth.js";
import { dbAppendAudit, dbListAudit, type AuditEvent } from "./db.js";

export async function audit(
  user: AuthUser,
  action: string,
  targetType: string,
  targetId: string,
  detail?: string,
): Promise<void> {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorSub: user.sub,
    actorEmail: user.email,
    action,
    targetType,
    targetId,
    detail,
  };
  await dbAppendAudit(event);
}

export async function listAudit(limit = 100): Promise<AuditEvent[]> {
  return dbListAudit(limit);
}
