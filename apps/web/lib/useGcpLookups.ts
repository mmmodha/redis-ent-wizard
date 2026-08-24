"use client";

import { useEffect, useMemo, useState } from "react";
import {
  listCredentials,
  listDnsZones,
  listMachineTypes,
  listProjects,
  listRegions,
  listReleases,
  type Credential,
  type DnsZoneInfo,
  type GkeOperatorInfo,
  type MachineTypeInfo,
  type ProjectInfo,
  type RegionInfo,
  type RsReleaseInfo,
} from "@/lib/api";

export const DEFAULT_RS_VERSION = "8.2.0-46";

export type GcpSettings = {
  credentialsFile: string;
  project: string;
  region_name: string;
  region_zones: string[];
  dns_managed_zone: string;
  dns_zone_dns_name: string;
};

const INITIAL_SETTINGS: GcpSettings = {
  credentialsFile: "",
  project: "",
  region_name: "",
  region_zones: ["b", "c", "d"],
  dns_managed_zone: "",
  dns_zone_dns_name: "",
};

export type UseGcpLookups = {
  credentials: Credential[];
  projects: ProjectInfo[];
  regions: RegionInfo[];
  machineTypes: MachineTypeInfo[];
  dnsZones: DnsZoneInfo[];
  vmReleases: RsReleaseInfo[];
  gkeReleases: GkeOperatorInfo[];
  loading: Record<string, boolean>;
  error: string;
  selectedRegion: RegionInfo | undefined;
  probeZone: string;
  settings: GcpSettings;
  setSettings: React.Dispatch<React.SetStateAction<GcpSettings>>;
};

/**
 * Cascading GCP lookups shared by the wizard and the visual designer.
 * credentials -> projects -> regions + DNS zones -> machine types.
 */
export function useGcpLookups(initial?: Partial<GcpSettings>): UseGcpLookups {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [machineTypes, setMachineTypes] = useState<MachineTypeInfo[]>([]);
  const [dnsZones, setDnsZones] = useState<DnsZoneInfo[]>([]);
  const [vmReleases, setVmReleases] = useState<RsReleaseInfo[]>([]);
  const [gkeReleases, setGkeReleases] = useState<GkeOperatorInfo[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  const [settings, setSettings] = useState<GcpSettings>({ ...INITIAL_SETTINGS, ...initial });

  const selectedRegion = useMemo(
    () => regions.find((r) => r.name === settings.region_name),
    [regions, settings.region_name],
  );

  const probeZone = useMemo(() => {
    if (!settings.region_name) return "";
    const suffix = settings.region_zones[0] || selectedRegion?.zoneSuffixes[0] || "b";
    return `${settings.region_name}-${suffix}`;
  }, [settings.region_name, settings.region_zones, selectedRegion]);

  useEffect(() => {
    listCredentials()
      .then(setCredentials)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to list credentials"));
    listReleases()
      .then((r) => {
        setVmReleases(r.vm);
        setGkeReleases(r.gke);
      })
      .catch(() => {
        setVmReleases([{ id: DEFAULT_RS_VERSION, label: "8.2.0-46 (default)", url: "" }]);
        setGkeReleases([{ id: "latest", label: "Latest operator chart", chartVersion: "" }]);
      });
  }, []);

  // Credentials -> projects
  useEffect(() => {
    if (!settings.credentialsFile) {
      setProjects([]);
      return;
    }
    setLoading((l) => ({ ...l, projects: true }));
    setError("");
    listProjects(settings.credentialsFile)
      .then((list) => {
        setProjects(list);
        const cred = credentials.find((c) => c.file === settings.credentialsFile);
        const preferred =
          cred?.projectId && list.some((p) => p.projectId === cred.projectId)
            ? cred.projectId
            : list[0]?.projectId || "";
        setSettings((prev) => ({ ...prev, project: prev.project || preferred }));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to list projects"))
      .finally(() => setLoading((l) => ({ ...l, projects: false })));
  }, [settings.credentialsFile, credentials]);

  // Project -> regions + DNS zones
  useEffect(() => {
    if (!settings.credentialsFile || !settings.project) {
      setRegions([]);
      setDnsZones([]);
      return;
    }
    setLoading((l) => ({ ...l, regions: true }));
    listRegions(settings.credentialsFile, settings.project)
      .then((list) => {
        setRegions(list);
        setSettings((prev) => ({
          ...prev,
          region_name:
            prev.region_name && list.some((r) => r.name === prev.region_name)
              ? prev.region_name
              : list.some((r) => r.name === "europe-west1")
                ? "europe-west1"
                : list[0]?.name || "",
        }));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to list regions"))
      .finally(() => setLoading((l) => ({ ...l, regions: false })));

    listDnsZones(settings.credentialsFile, settings.project)
      .then((zones) => {
        const sorted = [...zones].sort((a, b) => {
          const publicFirst = Number(b.visibility === "public") - Number(a.visibility === "public");
          return publicFirst || a.name.localeCompare(b.name);
        });
        setDnsZones(sorted);
        setSettings((prev) => {
          if (prev.dns_managed_zone && sorted.some((z) => z.name === prev.dns_managed_zone)) {
            return prev;
          }
          const preferred =
            sorted.find((z) => z.name === "demo-clusters") ||
            sorted.find((z) => z.visibility === "public" && z.dnsName.endsWith("demo.redislabs.com")) ||
            sorted.find((z) => z.visibility === "public") ||
            sorted[0];
          return preferred
            ? { ...prev, dns_managed_zone: preferred.name, dns_zone_dns_name: preferred.dnsName }
            : prev;
        });
      })
      .catch(() => setDnsZones([]));
  }, [settings.credentialsFile, settings.project]);

  // Region zones default to what the region actually offers
  useEffect(() => {
    if (!selectedRegion) return;
    setSettings((prev) => {
      const valid = prev.region_zones.filter((z) => selectedRegion.zoneSuffixes.includes(z));
      const next = valid.length ? valid : selectedRegion.zoneSuffixes.slice(0, 3);
      return next.join(",") === prev.region_zones.join(",") ? prev : { ...prev, region_zones: next };
    });
  }, [selectedRegion]);

  // Zone -> machine types
  useEffect(() => {
    if (!settings.credentialsFile || !settings.project || !probeZone) {
      setMachineTypes([]);
      return;
    }
    setLoading((l) => ({ ...l, machines: true }));
    listMachineTypes(settings.credentialsFile, settings.project, probeZone)
      .then(setMachineTypes)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to list machine types"))
      .finally(() => setLoading((l) => ({ ...l, machines: false })));
  }, [settings.credentialsFile, settings.project, probeZone]);

  return {
    credentials,
    projects,
    regions,
    machineTypes,
    dnsZones,
    vmReleases,
    gkeReleases,
    loading,
    error,
    selectedRegion,
    probeZone,
    settings,
    setSettings,
  };
}
