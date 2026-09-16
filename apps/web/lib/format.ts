/** Display helpers for the Resources & Cost view. */

/**
 * Format a money amount, or "—" when undefined (unpriced). Hourly rates are
 * small, so show more precision under $1; larger running totals show cents.
 */
export function formatMoney(amount: number | undefined, currency = "USD"): string {
  if (amount === undefined || Number.isNaN(amount)) return "—";
  const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** Compact age from an RFC3339 creation timestamp, e.g. "3d 4h", "5h", "12m". */
export function formatAge(creationTimestamp?: string, now: number = Date.now()): string {
  if (!creationTimestamp) return "—";
  const created = Date.parse(creationTimestamp);
  if (Number.isNaN(created)) return "—";
  const mins = Math.max(0, Math.floor((now - created) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
