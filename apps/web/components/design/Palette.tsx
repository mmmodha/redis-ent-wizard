"use client";

import { BrandIcon, type IconName } from "@/components/design/BrandIcon";
import type { NodeKind } from "@/lib/diagram";

export const PALETTE_MIME = "application/x-redis-design-kind";

type PaletteItem = { kind: NodeKind; label: string; icon: IconName; hint: string };

const ITEMS: PaletteItem[] = [
  { kind: "cluster", label: "Redis cluster", icon: "cluster", hint: "Drop on the network or GKE root" },
  { kind: "database", label: "Database", icon: "database", hint: "Drop inside a cluster" },
  { kind: "vms", label: "Set of VMs", icon: "vm", hint: "Drop on the network root (VM mode)" },
  { kind: "application", label: "Application", icon: "application", hint: "Drop on the root" },
  { kind: "loadbalancer", label: "Load balancer", icon: "load-balancer", hint: "Drop on VMs or an app" },
];

export function Palette({
  mode,
  redisEnabled = true,
  disabled,
}: {
  mode: "vm" | "gke";
  redisEnabled?: boolean;
  disabled?: boolean;
}) {
  const items = ITEMS.filter((i) => {
    if (mode === "gke" && i.kind === "vms") return false;
    if (!redisEnabled && (i.kind === "cluster" || i.kind === "database")) return false;
    return true;
  });
  return (
    <div className={`design-palette ${disabled ? "design-palette-disabled" : ""}`}>
      <p className="page-eyebrow" style={{ margin: "0 0 8px" }}>
        Components
      </p>
      <div className="design-palette-list">
        {items.map((item) => (
          <div
            key={item.kind}
            className="design-palette-item"
            draggable={!disabled}
            aria-disabled={disabled || undefined}
            onDragStart={(e) => {
              if (disabled) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.setData(PALETTE_MIME, item.kind);
              e.dataTransfer.effectAllowed = "move";
            }}
            title={disabled ? "Select a service account key first" : item.hint}
          >
            <BrandIcon name={item.icon} size={18} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
