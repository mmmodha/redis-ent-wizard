"use client";

import { Suspense } from "react";
import { EditWorkspace } from "@/components/create/EditWorkspace";

// Legacy standalone Design route. Kept for fallback; surfaced in the nav only
// when the legacy-create-flows feature flag is enabled. The unified /edit tab is
// the default entry point.
export default function DesignPage() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <EditWorkspace lockedView="diagram" />
    </Suspense>
  );
}
