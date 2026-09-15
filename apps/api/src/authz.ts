import type { AuthUser } from "./auth.js";
import type { InstanceRecord } from "./types.js";

export function isAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

export function canViewInstance(user: AuthUser, inst: InstanceRecord): boolean {
  if (isAdmin(user)) return true;
  if (inst.ownerSub && inst.ownerSub === user.sub) return true;
  if (!inst.ownerSub && inst.ownerEmail === user.email) return true;
  // Team folders: users can see instances in folders they share by naming convention
  // (folder membership is soft until group→folder bindings exist).
  return false;
}

export function canMutateInstance(user: AuthUser, inst: InstanceRecord): boolean {
  return canViewInstance(user, inst);
}

export function canManageCredentials(user: AuthUser, ownerSub: string): boolean {
  return isAdmin(user) || user.sub === ownerSub;
}

export function filterInstances(user: AuthUser, list: InstanceRecord[]): InstanceRecord[] {
  if (isAdmin(user)) return list;
  return list.filter((i) => canViewInstance(user, i));
}

export function assertCanView(user: AuthUser, inst: InstanceRecord): void {
  if (!canViewInstance(user, inst)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

export function assertCanMutate(user: AuthUser, inst: InstanceRecord): void {
  if (!canMutateInstance(user, inst)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

export function assertAdmin(user: AuthUser): void {
  if (!isAdmin(user)) {
    throw Object.assign(new Error("Admin role required"), { statusCode: 403 });
  }
}

/**
 * Fail-closed route guard for scoped API tokens. A `define`-scoped principal
 * (an AI tool via MCP) may only:
 *   - issue read requests (GET/HEAD), and
 *   - use the define surface (`/designs*`: validate, render, save drafts, read).
 * Every other route — chiefly the cloud-mutating ones (`POST /instances`,
 * `DELETE /instances/:id`, `/bulk-destroy`, `/retry`, `/recreate`, credential
 * and artifact writes) — is refused with 403. Full/OIDC users are unrestricted.
 *
 * This is an allowlist, not a blocklist: any new mutating route is denied to
 * define tokens by default, so the "define, don't provision" guarantee can't be
 * eroded by adding routes.
 */
export function assertScopeAllows(user: AuthUser, method: string, path: string): void {
  if (user.scope !== "define") return;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
  if (path === "/designs" || path.startsWith("/designs/")) return;
  throw Object.assign(
    new Error(
      "This token is scoped to define infrastructure only; provisioning and mutating routes are not permitted",
    ),
    { statusCode: 403 },
  );
}
