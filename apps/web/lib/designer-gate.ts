/** The visual designer needs a valid GCP key before machine types and preflight work. */

export function canUseDesignerCanvas(input: {
  credentialsFile?: string;
  credentialValid?: boolean;
}): boolean {
  return Boolean(input.credentialsFile?.trim()) && input.credentialValid === true;
}

export function designerLockReason(input: {
  credentialsFile?: string;
  credentialValid?: boolean;
}): string {
  if (canUseDesignerCanvas(input)) return "";
  if (!input.credentialsFile?.trim()) {
    return "Select a service account key before using the designer.";
  }
  return "The selected service account key is invalid. Pick a valid key before designing.";
}
