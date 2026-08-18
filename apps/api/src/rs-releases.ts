export type RsRelease = {
  id: string;
  label: string;
  url: string;
};

export type GkeOperatorRelease = {
  id: string;
  label: string;
  chartVersion: string;
};

export const DEFAULT_RS_VERSION = "8.2.0-46";

const S3 = "https://s3.amazonaws.com/redis-enterprise-software-downloads";

function jammyTar(version: string, folder: string): string {
  return `${S3}/${folder}/redislabs-${version}-jammy-amd64.tar`;
}

export const VM_RS_RELEASES: RsRelease[] = [
  {
    id: "8.2.0-46",
    label: "8.2.0-46 (default)",
    url: jammyTar("8.2.0-46", "8.2.0"),
  },
  {
    id: "8.0.20-68",
    label: "8.0.20-68",
    url: jammyTar("8.0.20-68", "8.0.20"),
  },
  {
    id: "7.22.0-241",
    label: "7.22.0-241",
    url: jammyTar("7.22.0-241", "7.22.0"),
  },
  {
    id: "7.22.0-28",
    label: "7.22.0-28",
    url: jammyTar("7.22.0-28", "7.22.0"),
  },
  {
    id: "7.8.6-13",
    label: "7.8.6-13",
    url: jammyTar("7.8.6-13", "7.8.6"),
  },
];

export const GKE_OPERATOR_RELEASES: GkeOperatorRelease[] = [
  { id: "latest", label: "Latest operator chart", chartVersion: "" },
  { id: "7.22.2-16", label: "Operator 7.22.2-16", chartVersion: "7.22.2-16" },
  { id: "7.8.6-2", label: "Operator 7.8.6-2", chartVersion: "7.8.6-2" },
];

const VM_BY_ID = new Map(VM_RS_RELEASES.map((r) => [r.id, r]));
const GKE_BY_ID = new Map(GKE_OPERATOR_RELEASES.map((r) => [r.id, r]));

export function rsVersionFromUrl(url: string): string {
  const m = String(url).match(/redislabs-(\d+\.\d+\.\d+-\d+)-/);
  return m ? m[1] : DEFAULT_RS_VERSION;
}

export function resolveVmRelease(idOrUrl?: string | null): RsRelease {
  const raw = (idOrUrl || "").trim();
  if (!raw || raw === DEFAULT_RS_VERSION) {
    return VM_BY_ID.get(DEFAULT_RS_VERSION)!;
  }
  const known = VM_BY_ID.get(raw);
  if (known) return known;
  if (/^https?:\/\//i.test(raw)) {
    return { id: rsVersionFromUrl(raw), label: rsVersionFromUrl(raw), url: raw };
  }
  throw new Error(`Unknown Redis Enterprise version: ${raw}`);
}

export function resolveGkeOperatorChart(id?: string | null): string {
  const raw = (id || "").trim();
  if (!raw || raw === "latest") return "";
  const known = GKE_BY_ID.get(raw);
  if (known) return known.chartVersion;
  throw new Error(`Unknown GKE operator version: ${raw}`);
}
