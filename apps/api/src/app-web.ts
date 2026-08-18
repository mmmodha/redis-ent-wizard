export type AppWebOptions = {
  exposeHttp: boolean;
  exposeHttps: boolean;
  memvizEnabled: boolean;
  extraPorts?: number[];
};

/** Ports already covered by dedicated App VM firewall rules / SSH. */
const RESERVED_APP_PORTS = new Set([22, 80, 443]);
const MAX_EXTRA_PORTS = 32;
const MAX_DISK_GIB = 65536;

/** GCP network tags applied to companion App VMs (never the Redis `http` tag). */
export function appVmNetworkTags(opts: AppWebOptions): string[] {
  const tags = ["ssh"];
  if (opts.exposeHttp) tags.push("app-http");
  if (opts.exposeHttps) tags.push("app-https");
  if (opts.memvizEnabled) tags.push("memviz");
  if ((opts.extraPorts || []).length) tags.push("app-extra");
  return tags;
}

/** Human-readable firewall summary for preflight / validate UI. */
export function describeAppWebExposure(
  opts: Omit<AppWebOptions, "memvizEnabled"> & { memvizEnabled?: boolean },
): string {
  const ports: string[] = [];
  if (opts.exposeHttp) ports.push("HTTP :80");
  if (opts.exposeHttps) ports.push("HTTPS :443");
  const extra = (opts.extraPorts || []).filter((p) => !RESERVED_APP_PORTS.has(p));
  if (extra.length) ports.push(`TCP ${extra.join(", ")}`);
  if (!ports.length) return "no public HTTP/HTTPS (SSH only)";
  return `${ports.join(" + ")} open from the internet`;
}

/**
 * One extra persistent-disk size (GiB) per App VM. `0` means boot disk only.
 * Invalid / out-of-range values become 0.
 */
export function normalizeAppDiskGib(opts: {
  app?: number;
  app_disk_gib?: number[];
}): number[] {
  const count = Math.max(0, opts.app ?? 0);
  const listed = opts.app_disk_gib || [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = Number(listed[i]);
    if (!Number.isFinite(raw) || raw <= 0 || raw > MAX_DISK_GIB) {
      out.push(0);
    } else {
      out.push(Math.floor(raw));
    }
  }
  return out;
}

/** Compact extra-disk summary, e.g. `boot disk only` or `VM1 +200 GiB /data`. */
export function summarizeAppDiskGib(sizes: number[]): string {
  if (!sizes.length || sizes.every((s) => s <= 0)) return "boot disk only";
  return sizes
    .map((s, i) => (s > 0 ? `VM${i + 1} +${s} GiB /data` : `VM${i + 1} boot only`))
    .join("; ");
}

/**
 * Parse a comma/space list or ranges (`8080, 9090` / `3000-3002`) into unique TCP ports.
 * SSH :22 and HTTP/HTTPS :80/:443 are skipped (dedicated rules). Throws on invalid input.
 */
export function parseAppExtraPorts(raw?: string | number[] | null): number[] {
  if (raw == null || raw === "") return [];
  const tokens = Array.isArray(raw)
    ? raw.map((n) => String(n).trim()).filter(Boolean)
    : String(raw)
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean);

  const seen = new Set<number>();
  const out: number[] = [];

  const add = (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Ports must be 1-65535");
    }
    if (RESERVED_APP_PORTS.has(port) || seen.has(port)) return;
    seen.add(port);
    out.push(port);
    if (out.length > MAX_EXTRA_PORTS) {
      throw new Error(`Too many extra ports (max ${MAX_EXTRA_PORTS})`);
    }
  };

  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error("Invalid port range");
      if (end - start + 1 > MAX_EXTRA_PORTS) {
        throw new Error("Port range too large");
      }
      for (let p = start; p <= end; p++) add(p);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new Error(`Invalid port: ${token}`);
    add(Number(token));
  }
  return out;
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
