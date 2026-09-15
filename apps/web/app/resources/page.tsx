"use client";

import { useCallback, useEffect, useState } from "react";
import { listCredentials, listGcpResources, type Credential, type ResourceScan } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StatusBadge } from "@/components/StatusBadge";
import { formatAge, formatMoney } from "@/lib/format";

const KIND_LABELS: Record<string, string> = {
  "compute.instance": "VM",
  "compute.disk": "Disk",
  "compute.address": "IP address",
  "compute.forwardingRule": "Forwarding rule",
  "compute.subnetwork": "Subnet",
  "compute.network": "Network",
  "compute.firewall": "Firewall",
  "sql.instance": "Cloud SQL",
  "gke.cluster": "GKE cluster",
  "storage.bucket": "Bucket",
  "pubsub.topic": "Pub/Sub topic",
  "pubsub.subscription": "Pub/Sub sub",
  "bigquery.dataset": "BigQuery dataset",
  "dns.record": "DNS record",
};

export default function ResourcesPage() {
  const { user, config, ready } = useAuth();
  const authed = !(config?.oidcEnabled && !config.authDisabled && !user);

  const [creds, setCreds] = useState<Credential[]>([]);
  const [selected, setSelected] = useState("");
  const [scan, setScan] = useState<ResourceScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Groups collapsed by the user (keyed by instance id or "__unowned__").
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    if (!ready || !authed) return;
    listCredentials()
      .then((list) => {
        setCreds(list);
        setSelected((cur) => cur || list.find((c) => c.valid)?.file || list[0]?.file || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load credentials"));
  }, [ready, authed]);

  const runScan = useCallback(
    async (refresh: boolean) => {
      if (!selected) return;
      setLoading(true);
      setError("");
      try {
        setScan(await listGcpResources(selected, undefined, refresh));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scan failed");
        setScan(null);
      } finally {
        setLoading(false);
      }
    },
    [selected],
  );

  // Auto-scan (cached) when the selected credential changes.
  useEffect(() => {
    if (selected) runScan(false);
  }, [selected, runScan]);

  const estimate = scan?.billingSource !== "billing-export";
  const costHrHeader = "Cost/hr (est.)";
  const costSoFarHeader = estimate ? "Cost so far (est.)" : "Cost so far (billed)";

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">GCP</p>
          <h2 className="page-title">Resources &amp; Cost</h2>
          <p className="page-sub">
            Live resources under a credential, grouped by the instance that created them.
          </p>
        </div>
        <div className="board-filters">
          <label className="inline-label">
            Credential
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {!creds.length ? <option value="">No credentials</option> : null}
              {creds.map((c) => (
                <option key={c.file} value={c.file}>
                  {(c.name || c.clientEmail || c.file) + (c.projectId ? ` · ${c.projectId}` : "")}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" disabled={loading || !selected} onClick={() => runScan(true)}>
            {loading ? "Scanning…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="notice notice-warn" role="note">
        Costs are <strong>approximate estimates</strong> from public list prices — they exclude
        sustained/committed-use discounts, exact regional pricing, egress and actual usage.
        {estimate
          ? " Cost so far = estimated rate × uptime."
          : " Cost so far reflects actual billed cost; cost/hr remains a list-price estimate."}{" "}
        For exact charges, use Cloud Billing. Resources that can't be priced show “—”.
      </div>

      {error ? <div className="error">{error}</div> : null}

      {scan ? (
        <>
          <div className="panel scan-summary">
            <div className="scan-totals">
              <span className="mono">
                ≈ {formatMoney(scan.totals.costPerHour, scan.currency)}/hr
              </span>
              <span className="mono">
                ≈ {formatMoney(scan.totals.costSoFar, scan.currency)} so far
              </span>
              <span className="hint">
                {scan.totals.resourceCount} resources
                {scan.totals.unpriced ? ` · ${scan.totals.unpriced} unpriced` : ""} · project{" "}
                <span className="mono">{scan.project}</span>
              </span>
            </div>
            <span className="hint">
              Scanned {new Date(scan.scannedAt).toLocaleString()}
              {scan.cached ? " (cached)" : ""}
            </span>
          </div>

          {scan.permissions.missing.length ? (
            <div className="notice notice-warn">
              The service account is missing list permissions, so some resources may be absent:{" "}
              <span className="mono">{scan.permissions.missing.join(", ")}</span>
            </div>
          ) : null}

          {loading ? <div className="empty">Scanning…</div> : null}

          {!scan.groups.length ? (
            <div className="empty">No live resources found for this credential.</div>
          ) : (
            <div className="group-stack">
              {scan.groups.map((g) => {
                const key = g.instanceId ?? "__unowned__";
                const unowned = g.instanceId === null;
                const isOpen = !collapsed.has(key);
                return (
                  <section className={`group-panel${unowned ? " group-unowned" : ""}`} key={key}>
                    <button
                      type="button"
                      className="group-head group-toggle"
                      aria-expanded={isOpen}
                      onClick={() => toggleGroup(key)}
                    >
                      <div className="group-title-row">
                        <span className={`companion-caret${isOpen ? " open" : ""}`} aria-hidden>
                          ▸
                        </span>
                        <span className="group-title">
                          {unowned ? "Unowned" : g.instanceName || g.instanceId}
                        </span>
                        {!unowned && g.status ? <StatusBadge status={g.status} /> : null}
                        {g.orphaned ? <span className="hint">no registry record</span> : null}
                        {unowned ? (
                          <span className="hint">not created by any known instance</span>
                        ) : null}
                      </div>
                      <span className="mono group-count">
                        {g.resourceCount} · ≈ {formatMoney(g.costPerHour, scan.currency)}/hr · ≈{" "}
                        {formatMoney(g.costSoFar, scan.currency)}
                      </span>
                    </button>
                    {isOpen ? (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Type</th>
                          <th>Location</th>
                          <th>Status</th>
                          <th>Age</th>
                          <th className="col-cost">{costHrHeader}</th>
                          <th className="col-cost">{costSoFarHeader}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.resources.map((r) => (
                          <tr key={`${r.kind}:${r.name}:${r.location}`}>
                            <td>
                              <strong>{r.name}</strong>
                              {r.owner ? <div className="hint mono">{r.owner}</div> : null}
                            </td>
                            <td className="mono">{KIND_LABELS[r.kind] || r.kind}</td>
                            <td className="mono">{r.location}</td>
                            <td className="mono">{r.status || "—"}</td>
                            <td className="mono">{formatAge(r.creationTimestamp)}</td>
                            <td className="mono col-cost">{formatMoney(r.costPerHour, r.currency || scan.currency)}</td>
                            <td className="mono col-cost">{formatMoney(r.costSoFar, r.currency || scan.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}

          {scan.warnings.length ? (
            <div className="hint scan-warnings">
              {scan.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          ) : null}
        </>
      ) : loading ? (
        <div className="empty">Scanning…</div>
      ) : (
        <div className="empty">Select a credential to scan its project.</div>
      )}
    </div>
  );
}
