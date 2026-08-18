import type { CheckResult } from "@/lib/api";

const ICON: Record<CheckResult["level"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
};

export function CheckList({ checks }: { checks: CheckResult[] }) {
  if (!checks.length) return null;

  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        {checks.length} checks · {failed} failed · {warned} warnings
      </p>
      <ul className="check-list">
        {checks.map((c) => (
          <li key={c.id} className={`check check-${c.level}`}>
            <span className="check-icon" aria-hidden>
              {ICON[c.level]}
            </span>
            <div>
              <div className="check-label">{c.label}</div>
              <div className="check-detail mono">{c.detail}</div>
              {c.guide ? <pre className="check-guide mono">{c.guide}</pre> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
