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
