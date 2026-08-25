export type StatusTone = "pass" | "fail" | "neutral";

const PASS = new Set(["ready", "active", "applied"]);

export function statusTone(status: string): StatusTone {
  const s = status.trim().toLowerCase();
  if (PASS.has(s)) return "pass";
  if (s === "failed") return "fail";
  return "neutral";
}

export function statusToneColor(status: string): string {
  const tone = statusTone(status);
  if (tone === "pass") return "var(--status-pass-bg)";
  if (tone === "fail") return "var(--status-fail-bg)";
  return "var(--redis-text-secondary)";
}
