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

export function designHasWorkload(nodes: Array<{ data: { kind: string } }>): boolean {
  return nodes.some(
    (n) => n.data.kind === "cluster" || n.data.kind === "vms" || n.data.kind === "application",
  );
}

export function designValidateHint(input: {
  hasWorkload: boolean;
  redisEnabled: boolean;
  mode: "vm" | "gke";
}): string {
  if (input.hasWorkload) return "";
  if (input.mode === "gke" || input.redisEnabled) {
    return "Add at least one Redis cluster before validating.";
  }
  return "Add a set of VMs or an application before validating.";
}
