/** Statuses where work is still happening, so the badge must keep moving.
 * `bootstrapping` counts: Terraform is done but the cluster is not usable yet. */
const IN_FLIGHT = new Set(["pending", "applying", "bootstrapping", "destroying"]);

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      {IN_FLIGHT.has(status) ? (
        <span className="spinner spinner-status" aria-hidden />
      ) : (
        <span className="status-dot" />
      )}
      {status}
    </span>
  );
}
