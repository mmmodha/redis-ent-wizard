import type { Progress, ResourceSection } from "@/lib/api";

function formatElapsed(seconds?: number): string {
  if (seconds === undefined) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const STATE_ICON: Record<string, string> = {
  done: "✓",
  active: "•",
  failed: "✕",
  pending: "",
};

function StateIcon({ state, className }: { state: string; className: string }) {
  if (state === "active") {
    return <span className={`${className} ${className}-active`} aria-hidden><span className="spinner" /></span>;
  }
  return (
    <span className={className} aria-hidden>
      {STATE_ICON[state]}
    </span>
  );
}

function SectionList({ sections }: { sections: ResourceSection[] }) {
  return (
    <ol className="section-list">
      {sections.map((s) => (
        <li key={s.id} className={`section-item section-${s.state}`}>
          <StateIcon state={s.state} className="section-icon" />
          <div className="section-body">
            <div className="section-row">
              <span className="section-label">{s.label}</span>
              <span className="mono section-count">
                {s.total > 0 ? `${Math.min(s.done, s.total)}/${s.total}` : "—"}
              </span>
            </div>
            {s.current ? <div className="section-current mono">{s.current}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ProgressTracker({
  progress,
  status,
}: {
  progress?: Progress;
  status?: string;
}) {
  if (!progress) return <div className="empty">Waiting for progress…</div>;

  const failed = status === "failed";
  // Degraded means the cluster stopped short of ready, so it must not look like work in flight.
  const stalled = failed || status === "degraded";
  const running = !stalled && progress.percent < 100;
  // Terraform has finished creating everything once the cluster is forming or up.
  const settled =
    progress.percent >= 100 || status === "bootstrapping" || status === "degraded";
  const barClass = [
    "bar-fill",
    stalled
      ? "bar-failed"
      : progress.percent >= 100
        ? "bar-done"
        : progress.operation === "destroy"
          ? "bar-destroy"
          : "",
    running ? "bar-running" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const sections = progress.sections ?? [];

  return (
    <div>
      <div className="progress-head">
        <strong className="phase-label">
          {running ? <span className="spinner spinner-inline" aria-hidden /> : null}
          {progress.operation === "destroy" ? "Teardown · " : ""}
          {progress.phaseLabel}
        </strong>
        <span className="mono">{progress.percent}%</span>
      </div>

      <div
        className="bar"
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={barClass} style={{ width: `${progress.percent}%` }} />
        {running ? <div className="bar-pending-run" /> : null}
      </div>

      <div className="progress-meta mono">
        {progress.resourcesTotal > 0
          ? `${progress.resourcesDone}/${progress.resourcesTotal} resources`
          : progress.operation === "destroy"
            ? "planning teardown"
            : "planning"}
        {progress.elapsedSeconds !== undefined
          ? ` · ${formatElapsed(progress.elapsedSeconds)} elapsed`
          : ""}
      </div>

      <ol className="step-list">
        {progress.steps.map((s) => (
          <li key={s.id} className={`step-item step-${s.state}`}>
            <StateIcon state={s.state} className="step-icon" />
            <div>
              <div>{s.label}</div>
              {s.detail ? <div className="check-detail mono">{s.detail}</div> : null}
            </div>
          </li>
        ))}
      </ol>

      {sections.length ? (
        <div className="section-block">
          <div className="section-heading">
            {progress.operation === "destroy"
              ? "Resources being deleted"
              : settled
                ? "Resources"
                : "Resources being created"}
          </div>
          <SectionList sections={sections} />
        </div>
      ) : null}
    </div>
  );
}
