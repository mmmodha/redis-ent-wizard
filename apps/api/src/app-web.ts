export type AppWebOptions = {
  exposeHttp: boolean;
  exposeHttps: boolean;
  memvizEnabled: boolean;
};

/** GCP network tags applied to companion App VMs (never the Redis `http` tag). */
export function appVmNetworkTags(opts: AppWebOptions): string[] {
  const tags = ["ssh"];
  if (opts.exposeHttp) tags.push("app-http");
  if (opts.exposeHttps) tags.push("app-https");
  if (opts.memvizEnabled) tags.push("memviz");
  return tags;
}

/** Human-readable firewall summary for preflight / validate UI. */
export function describeAppWebExposure(
  opts: Omit<AppWebOptions, "memvizEnabled"> & { memvizEnabled?: boolean },
): string {
  const ports: string[] = [];
  if (opts.exposeHttp) ports.push("HTTP :80");
  if (opts.exposeHttps) ports.push("HTTPS :443");
  if (!ports.length) return "no public HTTP/HTTPS (SSH only)";
  return `${ports.join(" + ")} open from the internet`;
}

const DEFAULT_APP_MACHINE = "n2-standard-8";

/**
 * One machine type per App VM. Accepts a per-VM list, or falls back to a single
 * legacy `app_machine_type` repeated for every VM.
 */
export function normalizeAppMachineTypes(opts: {
  app?: number;
  app_machine_types?: string[];
  app_machine_type?: string;
  fallback?: string;
}): string[] {
  const count = Math.max(0, opts.app ?? 0);
  if (count === 0) return [];

  const fallback =
    (opts.fallback || opts.app_machine_type || DEFAULT_APP_MACHINE).trim() || DEFAULT_APP_MACHINE;
  const listed = opts.app_machine_types || [];

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = String(listed[i] ?? "").trim();
    out.push(raw || fallback);
  }
  return out;
}

/** Compact summary like `n2-standard-8, e2-standard-2`. */
export function summarizeAppMachineTypes(types: string[]): string {
  if (!types.length) return "None";
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) || 0) + 1);
  if (counts.size === 1) {
    const [name, n] = [...counts.entries()][0];
    return n === 1 ? name : `${n} × ${name}`;
  }
  return types.join(", ");
}
