import Link from "next/link";
import { InstanceBoard } from "@/components/InstanceBoard";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">Instances</h2>
          <p className="page-sub">
            Group by folder or owner, select many, destroy or move in bulk.
          </p>
        </div>
        <Link className="btn btn-primary" href="/wizard">
          New instance
        </Link>
      </div>

      <div className="panel">
        <InstanceBoard />
      </div>
    </div>
  );
}
