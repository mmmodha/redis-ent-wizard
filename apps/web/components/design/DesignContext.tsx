"use client";

import { createContext, useContext } from "react";
import type { MachineTypeInfo } from "@/lib/api";
import type { DesignNode, DesignSettings } from "@/lib/diagram";

type DesignContextValue = {
  machineTypes: MachineTypeInfo[];
  nodes: DesignNode[];
  settings: DesignSettings | null;
};

const DesignContext = createContext<DesignContextValue>({
  machineTypes: [],
  nodes: [],
  settings: null,
});

export const DesignProvider = DesignContext.Provider;

export function useDesignContext(): DesignContextValue {
  return useContext(DesignContext);
}

const CLUSTER_OVERHEAD = 0.85;

/**
 * Usable memory for a cluster minus the memory already committed to its child
 * databases. Positive means capacity remains; negative means over-committed.
 */
export function clusterCapacityMB(
  clusterId: string,
  clusterNodes: number,
  machineType: string,
  machineTypes: MachineTypeInfo[],
  nodes: DesignNode[],
): { totalMB: number; usedMB: number; remainingMB: number } {
  const machineMemoryMB = machineTypes.find((m) => m.name === machineType)?.memoryMb ?? 0;
  const totalMB = clusterNodes * machineMemoryMB * CLUSTER_OVERHEAD;
  const usedMB = nodes
    .filter((n) => n.parentId === clusterId && n.data.kind === "database")
    .reduce((sum, n) => sum + Number((n.data as { memory_gb: number }).memory_gb) * 1024, 0);
  return { totalMB, usedMB, remainingMB: totalMB - usedMB };
}
