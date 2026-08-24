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

export function Palette({ mode }: { mode: "vm" | "gke" }) {
  const items = mode === "gke" ? ITEMS.filter((i) => i.kind !== "vms") : ITEMS;
  return (
    <div className="design-palette">
      <p className="page-eyebrow" style={{ margin: "0 0 8px" }}>
        Components
      </p>
      <div className="design-palette-list">
        {items.map((item) => (
          <div
            key={item.kind}
            className="design-palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_MIME, item.kind);
              e.dataTransfer.effectAllowed = "move";
            }}
            title={item.hint}
          >
            <BrandIcon name={item.icon} size={18} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
