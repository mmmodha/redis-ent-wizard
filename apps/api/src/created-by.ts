/** Workplace policy: Created by / GCP `owner` is always firstName_lastName. */

export const CREATED_BY_PATTERN = /^[a-z][a-z0-9]*_[a-z][a-z0-9]*$/;
export const CREATED_BY_ERROR =
  "Created by must be firstName_lastName (e.g. mehul_modha)";

export function canonicalCreatedBy(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidCreatedBy(value: string): boolean {
  return CREATED_BY_PATTERN.test(canonicalCreatedBy(value));
}

/** GCP owner label is the Created by value (already first_last, lowercased). */
export function gcpOwnerLabel(createdBy: string): string {
  return canonicalCreatedBy(createdBy);
}

/** Labels applied to GCP resources. skip_deletion is opt-in. */
export function gcpResourceLabels(opts: { owner: string; skipDeletion: boolean }): Record<string, string> {
  const labels: Record<string, string> = { owner: gcpOwnerLabel(opts.owner) };
  if (opts.skipDeletion) labels.skip_deletion = "yes";
  return labels;
}

export function resolveCreatedBy(
  createdBy: string | undefined,
  _user?: { email?: string; name?: string },
): string {
  const fromInput = createdBy?.trim() ?? "";
  if (!fromInput || !isValidCreatedBy(fromInput)) return "";
  return canonicalCreatedBy(fromInput);
}
