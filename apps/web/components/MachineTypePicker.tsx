"use client";

import { useEffect, useMemo, useState } from "react";
import type { MachineTypeInfo } from "@/lib/api";

function familyOf(name: string): string {
  const base = name.split("-")[0] || name;
  return base.toLowerCase();
}

function formatMachine(m: MachineTypeInfo, showNvme = false): string {
  const ssd =
    !showNvme || m.maxLocalSsds === undefined
      ? ""
      : m.maxLocalSsds === 0
        ? " · no Local SSD"
        : ` · up to ${m.maxLocalSsds} NVMe`;
  return `${m.name} — ${m.guestCpus} vCPU, ${Math.round(m.memoryMb / 1024)} GB${ssd}`;
}

const FAMILY_ORDER = ["e2", "n2", "n2d", "n1", "c2", "c2d", "c3", "c3d", "t2d", "m1", "m3", "a2", "g2"];

function sortFamilies(families: string[]): string[] {
  return [...families].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a);
    const ib = FAMILY_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

export function MachineTypePicker({
  label,
  value,
  onChange,
  machineTypes,
  loading,
  disabled,
  showNvmeHint,
  hint,
  preferredFamilies,
}: {
  label: string;
  value: string;
  onChange: (machineType: string) => void;
  machineTypes: MachineTypeInfo[];
  loading?: boolean;
  disabled?: boolean;
  showNvmeHint?: boolean;
  hint?: string;
  /** When set, only these families appear first / preferred (others still listed). */
  preferredFamilies?: string[];
}) {
  const families = useMemo(() => {
    const set = new Set(machineTypes.map((m) => familyOf(m.name)));
    return sortFamilies([...set]);
  }, [machineTypes]);

  const inferredFamily = value ? familyOf(value) : "";
  const [family, setFamily] = useState(inferredFamily || preferredFamilies?.[0] || "e2");

  useEffect(() => {
    if (value) {
      const f = familyOf(value);
      setFamily((prev) => (prev === f ? prev : f));
      return;
    }
    if (!families.length) return;
    const preferred = preferredFamilies?.find((f) => families.includes(f));
    const next = preferred || families[0];
    setFamily((prev) => (prev && families.includes(prev) ? prev : next));
  }, [value, families, preferredFamilies]);

  const filtered = useMemo(() => {
    const list = machineTypes.filter((m) => familyOf(m.name) === family);
    return list.sort((a, b) => a.guestCpus - b.guestCpus || a.name.localeCompare(b.name));
  }, [machineTypes, family]);

  useEffect(() => {
    if (!filtered.length) return;
    if (value && filtered.some((m) => m.name === value)) return;
    const prefer =
      filtered.find((m) => m.name.endsWith("-standard-8")) ||
      filtered.find((m) => m.name.endsWith("-standard-4")) ||
      filtered.find((m) => m.name.endsWith("-standard-2")) ||
      filtered[0];
    if (prefer && prefer.name !== value) onChange(prefer.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-pick when family filter changes
  }, [family, filtered]);

  return (
    <div className="machine-picker">
      <span className="machine-picker-label">{label}</span>
      <div className="machine-picker-row">
        <label className="machine-picker-family">
          Family
          <select
            value={family}
            disabled={disabled || loading || !families.length}
            onChange={(e) => setFamily(e.target.value)}
          >
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="machine-picker-type">
          Machine type
          <select
            value={value}
            disabled={disabled || loading || !filtered.length}
            onChange={(e) => onChange(e.target.value)}
          >
            {loading ? <option value="">Loading…</option> : null}
            {!loading && !filtered.length ? <option value="">No types in {family}</option> : null}
            {filtered.map((m) => (
              <option key={m.name} value={m.name}>
                {formatMachine(m, showNvmeHint)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
