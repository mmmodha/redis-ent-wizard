"use client";

import Link from "next/link";
import type { UseGcpLookups } from "@/lib/useGcpLookups";

export type DesignMeta = {
  name: string;
  env: string;
  folder: string;
  youremail: string;
  skip_deletion: boolean;
  redis_enabled: boolean;
  mode: "vm" | "gke";
  RS_admin: string;
  operator_chart_version: string;
};

export function ownerError(value: string): string {
  const v = value.trim();
  if (!v) return "Required — firstName_lastName (e.g. mehul_modha)";
  if (!/^[A-Za-z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9]*$/.test(v)) {
    return "Use firstName_lastName (e.g. mehul_modha)";
  }
  return "";
}

export function DeploymentSettings({
  gcp,
  meta,
  setMeta,
  onModeChange,
}: {
  gcp: UseGcpLookups;
  meta: DesignMeta;
  setMeta: React.Dispatch<React.SetStateAction<DesignMeta>>;
  onModeChange: (mode: "vm" | "gke") => void;
}) {
  const { credentials, projects, regions, dnsZones, selectedRegion, loading, settings, setSettings } = gcp;
  const oe = ownerError(meta.youremail);
  const validCredential = credentials.find((c) => c.file === settings.credentialsFile)?.valid;

  return (
    <div className="design-settings">
      <div className="design-mode-toggle">
        <button
          type="button"
          className={`chip ${meta.mode === "vm" ? "chip-active" : ""}`}
          onClick={() => onModeChange("vm")}
        >
          VM deployment
        </button>
        <button
          type="button"
          className={`chip ${meta.mode === "gke" ? "chip-active" : ""}`}
          onClick={() => onModeChange("gke")}
        >
          GKE deployment
        </button>
      </div>

      <div className="design-settings-grid">
        <label>
          Instance name
          <input
            value={meta.name}
            onChange={(e) =>
              setMeta((m) => ({ ...m, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))
            }
            placeholder="demo01"
          />
        </label>

        <label>
          Environment tag
          <input
            value={meta.env}
            onChange={(e) =>
              setMeta((m) => ({ ...m, env: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))
            }
          />
        </label>

        <label>
          Folder
          <input
            value={meta.folder}
            onChange={(e) => setMeta((m) => ({ ...m, folder: e.target.value.slice(0, 60) }))}
            placeholder="team-emea / customer-acme"
          />
        </label>

        <label>
          <span className="field-required">Created by</span>
          <input
            value={meta.youremail}
            onChange={(e) => setMeta((m) => ({ ...m, youremail: e.target.value.toLowerCase() }))}
            placeholder="mehul_modha"
            aria-invalid={Boolean(oe)}
          />
          {oe ? <span className="field-error">{oe}</span> : (
            <span className="hint">Workplace policy: firstName_lastName — the GCP owner label</span>
          )}
        </label>

        <label>
          Skip deletion label
          <select
            value={meta.skip_deletion ? "yes" : "no"}
            onChange={(e) => setMeta((m) => ({ ...m, skip_deletion: e.target.value === "yes" }))}
          >
            <option value="no">No — omit skip_deletion</option>
            <option value="yes">Yes — add skip_deletion=yes</option>
          </select>
        </label>

        {meta.mode === "vm" ? (
          <label className="design-check-row">
            <input
              type="checkbox"
              checked={meta.redis_enabled}
              onChange={(e) => setMeta((m) => ({ ...m, redis_enabled: e.target.checked }))}
            />
            Include Redis Enterprise cluster
            <span className="hint" style={{ flexBasis: "100%", margin: 0 }}>
              Off deploys only application VMs on the VPC. GKE still requires Redis.
            </span>
          </label>
        ) : null}

        <label>
          Service account key
          <select
            value={settings.credentialsFile}
            onChange={(e) => setSettings((s) => ({ ...s, credentialsFile: e.target.value }))}
          >
            <option value="">Select credentials…</option>
            {credentials.map((c) => (
              <option key={c.file} value={c.file} disabled={!c.valid}>
                {c.name || c.file}
                {c.projectId ? ` — ${c.projectId}` : ""}
                {c.valid ? "" : " (invalid)"}
              </option>
            ))}
          </select>
          <span className="hint">
            <Link href="/credentials">Manage keys</Link>
          </span>
        </label>

        <label>
          GCP project
          <select
            value={settings.project}
            onChange={(e) => setSettings((s) => ({ ...s, project: e.target.value }))}
            disabled={!projects.length}
          >
            {loading.projects ? <option value="">Loading projects…</option> : null}
            {!loading.projects && !projects.length ? (
              <option value="">Select credentials first</option>
            ) : null}
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name} ({p.projectId})
              </option>
            ))}
          </select>
        </label>

        <label>
          Region
          <select
            value={settings.region_name}
            onChange={(e) => setSettings((s) => ({ ...s, region_name: e.target.value }))}
            disabled={!regions.length}
          >
            {loading.regions ? <option value="">Loading regions…</option> : null}
            {!loading.regions && !regions.length ? (
              <option value="">Select a project first</option>
            ) : null}
            {regions.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} ({r.zoneSuffixes.length} zones)
              </option>
            ))}
          </select>
        </label>

        <div className="design-field-wide">
          <span className="machine-picker-label">Zones</span>
          <div className="zone-picker">
            {(selectedRegion?.zoneSuffixes || []).map((z) => {
              const active = settings.region_zones.includes(z);
              return (
                <button
                  key={z}
                  type="button"
                  className={`chip ${active ? "chip-active" : ""}`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      region_zones: active
                        ? s.region_zones.filter((x) => x !== z)
                        : [...s.region_zones, z].sort(),
                    }))
                  }
                >
                  {settings.region_name}-{z}
                </button>
              );
            })}
          </div>
        </div>

        <label>
          DNS managed zone
          <select
            value={settings.dns_managed_zone}
            onChange={(e) => {
              const zone = dnsZones.find((z) => z.name === e.target.value);
              setSettings((s) => ({
                ...s,
                dns_managed_zone: e.target.value,
                dns_zone_dns_name: zone?.dnsName || s.dns_zone_dns_name,
              }));
            }}
            disabled={!dnsZones.length}
          >
            {dnsZones.length ? null : <option value="">No managed zones found</option>}
            {dnsZones.map((z) => (
              <option key={z.name} value={z.name}>
                {z.name} → {z.dnsName}
              </option>
            ))}
          </select>
        </label>

        {meta.mode === "vm" ? (
          <label>
            Redis Enterprise admin
            <input
              value={meta.RS_admin}
              onChange={(e) => setMeta((m) => ({ ...m, RS_admin: e.target.value }))}
            />
          </label>
        ) : (
          <label>
            Operator / Redis version
            <select
              value={meta.operator_chart_version}
              onChange={(e) => setMeta((m) => ({ ...m, operator_chart_version: e.target.value }))}
            >
              {(gcp.gkeReleases.length
                ? gcp.gkeReleases
                : [{ id: "latest", label: "Latest operator chart", chartVersion: "" }]
              ).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!validCredential && settings.credentialsFile ? (
        <p className="field-error">Selected credential is invalid.</p>
      ) : null}
    </div>
  );
}
