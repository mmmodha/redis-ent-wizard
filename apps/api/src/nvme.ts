/** Approximate max Local SSD (NVMe) attachments by machine family.
 * Source: https://cloud.google.com/compute/docs/disks/local-ssd#choose_a_machine_type
 * Prefer failing closed with a warning when unknown. */
export function maxLocalSsdsForMachineType(machineType: string): number | undefined {
  const name = machineType.toLowerCase();
  if (name.startsWith("e2-")) return 0; // e2 does not support Local SSD
  if (name.startsWith("t2d-") || name.startsWith("t2a-")) return 0;
  if (name.startsWith("n1-")) return 24;
  if (name.startsWith("n2-") || name.startsWith("n2d-")) return 24;
  if (name.startsWith("c2-") || name.startsWith("c2d-")) return 8;
  if (name.startsWith("c3-") || name.startsWith("c3d-")) return 16;
  if (name.startsWith("m1-") || name.startsWith("m2-") || name.startsWith("m3-")) return 8;
  if (name.startsWith("a2-") || name.startsWith("a3-") || name.startsWith("g2-")) return 0;
  // Conservative default for other custom/newer families
  return 8;
}

export const LOCAL_SSD_GIB = 375;
