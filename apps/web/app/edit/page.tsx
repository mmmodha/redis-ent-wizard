"use client";

import { Suspense } from "react";
import { EditWorkspace } from "@/components/create/EditWorkspace";

export default function EditPage() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <EditWorkspace />
    </Suspense>
  );
}
