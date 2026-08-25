"use client";

import { useMemo, useState } from "react";
import {
  reconcileDatabases,
  type DatabaseState,
  type Instance,
} from "@/lib/api";
import { clusterTrialShardGate, isTrialShardLicenseError } from "@/lib/trial-shards";

type ClusterRow = Record<string, unknown>;
type DbRow = Record<string, unknown>;

type FailedEdit = {
  cluster: string;
  name: string;
  sharding: boolean;
  shards_count: number;
  replication: boolean;
  skip: boolean;
};

function clustersOf(inst: Instance): ClusterRow[] {
  const cfg = (inst.config || {}) as Record<string, unknown>;
  return Array.isArray(cfg.clusters) ? (cfg.clusters as ClusterRow[]) : [];
}

function dbsOf(cluster: ClusterRow): DbRow[] {
  return Array.isArray(cluster.databases) ? (cluster.databases as DbRow[]) : [];
}

export function DatabaseRetryPanel({
  inst,
  states,
  onError,
}: {
  inst: Instance;
  states: DatabaseState[];
  onError: (msg: string) => void;
}) {
  const failed = states.filter((s) => s.status === "failed");
  const licenseFail = failed.some((s) => isTrialShardLicenseError(s.error));
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<FailedEdit[]>(() =>
    failed.map((s) => {
      const cluster = clustersOf(inst).find((c) => String(c.name || "") === s.cluster);
      const db = dbsOf(cluster || {}).find((d) => String(d.name || "") === s.name) || {};
      return {
        cluster: s.cluster,
        name: s.name,
        sharding: Boolean(db.sharding),
        shards_count: Number(db.shards_count) || 2,
        replication: Boolean(db.replication),
        skip: false,
      };
    }),
  );

  const previewGate = useMemo(() => {
    const clusters = clustersOf(inst);
    for (const c of clusters) {
      const name = String(c.name || "");
      const kept: DbRow[] = [];
      for (const db of dbsOf(c)) {
        const edit = edits.find((e) => e.cluster === name && e.name === String(db.name || ""));
        if (edit?.skip) continue;
        if (edit) {
          kept.push({ ...db, sharding: edit.sharding, shards_count: edit.shards_count, replication: edit.replication });
        } else {
          kept.push(db);
        }
      }
      const gate = clusterTrialShardGate({
        name,
        license: String(c.license || ""),
        databases: kept,
        nodes: Number(c.nodes || c.rec_nodes || 1),
      });
      if (gate.blocked) return gate;
    }
    return null;
  }, [edits, inst]);

  if (!failed.length) return null;

  async function run(withEdits: boolean) {
    setBusy(true);
    onError("");
    try {
      if (!withEdits) {
        await reconcileDatabases(inst.id);
        return;
      }
      if (previewGate?.blocked) {
        onError(previewGate.message);
        return;
      }
      const clusters = clustersOf(inst).map((c) => {
        const name = String(c.name || "");
        const databases = dbsOf(c)
          .map((db) => {
            const edit = edits.find((e) => e.cluster === name && e.name === String(db.name || ""));
            if (edit?.skip) return null;
            if (!edit) return db;
            return {
              ...db,
              sharding: edit.sharding,
              shards_count: edit.sharding ? edit.shards_count : 1,
              replication: edit.replication,
            };
          })
          .filter((d): d is DbRow => d !== null);
        return { name, databases };
      });
      await reconcileDatabases(inst.id, { clusters });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Database retry failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notice notice-warn" style={{ marginTop: 12 }}>
      <p style={{ margin: "0 0 8px" }}>
        {failed.length} database(s) failed to create.
        {licenseFail
          ? " A trial license allows 4 shards — reduce shards, turn off HA, skip a database, or apply a license, then retry."
          : " Retry as-is, or edit the failed databases and retry."}
      </p>
      {edits.map((e) => (
        <div key={`${e.cluster}/${e.name}`} className="summary-row" style={{ alignItems: "center", gap: 12 }}>
          <div className="summary-label">
            {e.cluster} / <span className="mono">{e.name}</span>
          </div>
          <div className="summary-value" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <label className="wiz-check-row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={e.skip}
                onChange={(ev) =>
                  setEdits((prev) => prev.map((x) => (x === e ? { ...x, skip: ev.target.checked } : x)))
                }
              />
              Skip
            </label>
            {!e.skip ? (
              <>
                <label className="wiz-check-row" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={e.sharding}
                    onChange={(ev) =>
                      setEdits((prev) =>
                        prev.map((x) => (x === e ? { ...x, sharding: ev.target.checked } : x)),
                      )
                    }
                  />
                  Sharding
                </label>
                {e.sharding ? (
                  <label style={{ margin: 0 }}>
                    Shards{" "}
                    <input
                      type="number"
                      min={2}
                      max={100}
                      value={e.shards_count}
                      onChange={(ev) =>
                        setEdits((prev) =>
                          prev.map((x) => (x === e ? { ...x, shards_count: Number(ev.target.value) } : x)),
                        )
                      }
                      style={{ width: 64 }}
                    />
                  </label>
                ) : null}
                <label className="wiz-check-row" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={e.replication}
                    onChange={(ev) =>
                      setEdits((prev) =>
                        prev.map((x) => (x === e ? { ...x, replication: ev.target.checked } : x)),
                      )
                    }
                  />
                  HA
                </label>
              </>
            ) : null}
          </div>
        </div>
      ))}
      {previewGate?.blocked ? <p className="hint">{previewGate.message}</p> : null}
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(false)}>
          {busy ? "Retrying…" : "Retry as-is"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || Boolean(previewGate?.blocked)}
          onClick={() => void run(true)}
        >
          Save changes and retry
        </button>
      </div>
    </div>
  );
}
