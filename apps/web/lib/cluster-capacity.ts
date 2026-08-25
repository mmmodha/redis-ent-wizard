export function formatMemoryGb(mb: number): string {
  const gb = mb / 1024;
  return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

export function clusterCapacityCaption(input: {
  catalogReady: boolean;
  remainingMB: number;
  ifUnavailable: "pending" | "hide";
}): string | null {
  if (!input.catalogReady) {
    return input.ifUnavailable === "pending" ? "capacity pending" : null;
  }
  const over = input.remainingMB < 0;
  return `${over ? "over by " : "free "}${formatMemoryGb(Math.abs(input.remainingMB))}`;
}

export function clusterCapacityClass(input: {
  catalogReady: boolean;
  remainingMB: number;
  ifUnavailable: "pending" | "hide";
}): string {
  if (!input.catalogReady) return "";
  return input.remainingMB < 0 ? "design-cap-bad" : "design-cap-free";
}

export function gcpProbeZone(region: string, zoneSuffixes?: string[]): string {
  const name = region.trim();
  if (!name) return "";
  const suffix = (zoneSuffixes?.[0] || "b").replace(/^-/, "");
  return `${name}-${suffix}`;
}

export function instanceCredentialsRef(inst: {
  credentialsId?: string;
  credentialsFile?: string;
}): string {
  const id = inst.credentialsId?.trim();
  if (id) return id;
  const file = inst.credentialsFile?.trim() || "";
  if (!file) return "";
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || "";
}
