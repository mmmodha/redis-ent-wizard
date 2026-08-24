"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  bulkDestroy,
  forgetInstance,
  listInstances,
  moveInstance,
  type Instance,
} from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";

type GroupBy = "folder" | "owner" | "status" | "none";

function groupKey(inst: Instance, by: GroupBy): string {
  if (by === "folder") return inst.folder?.trim() || "Ungrouped";
  if (by === "owner") return inst.ownerEmail || "Unknown owner";
  if (by === "status") return inst.status;
  return "All instances";
}

function uiUrl(inst: Instance): string {
  return (
    (inst.endpoints?.rs_ui_ip as string) ||
    (inst.endpoints?.rec_ui_url as string) ||
    (Array.isArray(inst.endpoints?.rs_ui_dns) ? (inst.endpoints?.rs_ui_dns as string[])[0] : "") ||
    ""
  );
}

export function InstanceBoard() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("folder");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [moveFolder, setMoveFolder] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await listInstances();
      setInstances(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "API unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const owners = useMemo(
    () => [...new Set(instances.map((i) => i.ownerEmail).filter(Boolean))].sort(),
    [instances],
  );
  const folders = useMemo(
    () => [...new Set(instances.map((i) => i.folder).filter(Boolean) as string[])].sort(),
    [instances],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return instances.filter((i) => {
      if (ownerFilter && i.ownerEmail !== ownerFilter) return false;
      if (folderFilter === "__ungrouped__" && i.folder) return false;
      if (folderFilter && folderFilter !== "__ungrouped__" && i.folder !== folderFilter) return false;
      if (!q) return true;
      return (
        i.id.toLowerCase().includes(q) ||
        i.ownerEmail.toLowerCase().includes(q) ||
        (i.folder || "").toLowerCase().includes(q) ||
        i.project.toLowerCase().includes(q)
      );
    });
  }, [instances, ownerFilter, folderFilter, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Instance[]>();
    for (const inst of filtered) {
      const key = groupKey(inst, groupBy);
      const list = map.get(key) || [];
      list.push(inst);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupBy]);

  const selectable = filtered.filter(
    (i) => i.status !== "destroying" && i.status !== "applying" && !i.busy,
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function onBulkDestroy() {
    const ids = [...selected].filter((id) => {
      const i = instances.find((x) => x.id === id);
      return i && i.status !== "destroyed" && i.status !== "destroying";
    });
    if (!ids.length) return;
    if (!confirm(`Destroy ${ids.length} instance(s) and all their GCP resources?`)) return;
    setBusy(true);
    try {
      await bulkDestroy(ids);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk destroy failed");
    } finally {
      setBusy(false);
    }
  }

  async function onBulkForget() {
    const ids = [...selected].filter((id) => {
      const i = instances.find((x) => x.id === id);
      return i && (i.status === "destroyed" || i.status === "failed");
    });
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} record(s) from the registry? Cloud resources are not touched.`))
      return;
    setBusy(true);
    try {
      for (const id of ids) await forgetInstance(id);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forget failed");
    } finally {
      setBusy(false);
    }
  }

  async function onMoveSelected() {
    const folder = moveFolder.trim() || null;
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await moveInstance(id, folder);
      setSelected(new Set());
      setMoveFolder("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = selected.size;

  return (
    <div>
      <div className="board-toolbar">
        <div className="board-filters">
          <input
            className="search-input"
            placeholder="Search name, owner, folder, project…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="inline-label">
            Group by
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="folder">Folder</option>
              <option value="owner">Owner</option>
              <option value="status">Status</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="inline-label">
            Folder
            <select value={folderFilter} onChange={(e) => setFolderFilter(e.target.value)}>
              <option value="">All folders</option>
              <option value="__ungrouped__">Ungrouped</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-label">
            Owner
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
              <option value="">All owners</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedCount > 0 ? (
          <div className="bulk-bar">
            <span className="mono">{selectedCount} selected</span>
            <input
              className="folder-input"
              list="folder-suggestions"
              placeholder="Move to folder…"
              value={moveFolder}
              onChange={(e) => setMoveFolder(e.target.value)}
            />
            <datalist id="folder-suggestions">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <button className="btn" type="button" disabled={busy} onClick={onMoveSelected}>
              Move
            </button>
            <button className="btn btn-danger" type="button" disabled={busy} onClick={onBulkDestroy}>
              Destroy selected
            </button>
            <button className="btn" type="button" disabled={busy} onClick={onBulkForget}>
              Forget records
            </button>
            <button className="btn" type="button" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="error">{error}. Is the API running on port 4000?</div> : null}

      {loading ? (
        <div className="empty">Loading instances…</div>
      ) : !filtered.length ? (
        <div className="empty">
          No instances match.{" "}
          <Link href="/wizard">Create one</Link> or clear filters.
        </div>
      ) : (
        <div className="group-stack">
          {groups.map(([name, rows]) => {
            const rowIds = rows
              .filter((i) => selectable.some((s) => s.id === i.id))
              .map((i) => i.id);
            const allChecked = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
            return (
              <section className="group-panel" key={name}>
                <header className="group-head">
                  <label className="check-label-inline">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      disabled={!rowIds.length}
                      onChange={() => toggleGroup(rowIds)}
                    />
                    <span className="group-title">{name}</span>
                  </label>
                  <span className="mono group-count">{rows.length}</span>
                </header>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="col-check" />
                      <th>Name</th>
                      <th>Owner</th>
                      <th>Mode</th>
                      <th>Status</th>
                      <th>Region</th>
                      <th>Progress</th>
                      <th>UI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((inst) => {
                      const canSelect = selectable.some((s) => s.id === inst.id);
                      const pct = inst.progress?.percent;
                      return (
                        <tr key={inst.id} className={selected.has(inst.id) ? "row-selected" : ""}>
                          <td className="col-check">
                            <input
                              type="checkbox"
                              checked={selected.has(inst.id)}
                              disabled={!canSelect}
                              onChange={() => toggle(inst.id)}
                              aria-label={`Select ${inst.id}`}
                            />
                          </td>
                          <td>
                            <Link href={`/instances/${encodeURIComponent(inst.id)}`}>
                              <strong>{inst.id}</strong>
                            </Link>
                            {inst.folder ? (
                              <div className="hint mono">{inst.folder}</div>
                            ) : null}
                            {inst.status === "destroyed" ? (
                              <div className="hint">
                                Edit in{" "}
                                <Link href={`/wizard?from=${encodeURIComponent(inst.id)}`}>
                                  wizard
                                </Link>{" "}
                                or{" "}
                                <Link href={`/design?from=${encodeURIComponent(inst.id)}`}>
                                  designer
                                </Link>
                              </div>
                            ) : null}
                          </td>
                          <td className="mono">{inst.ownerEmail}</td>
                          <td className="mono">{inst.mode.toUpperCase()}</td>
                          <td>
                            <StatusBadge status={inst.status} />
                          </td>
                          <td className="mono">{inst.region}</td>
                          <td className="mono">
                            {pct !== undefined ? (
                              <span>
                                {pct}%
                                {inst.progress?.operation === "destroy" ? " ↓" : ""}
                              </span>
                            ) : (
                              "—"
                            )}
                            {inst.health && inst.status === "bootstrapping" ? (
                              <div className="hint mono">
                                {inst.health.nodesActive}/{inst.health.nodesExpected} nodes
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {uiUrl(inst) ? (
                              <a
                                href={uiUrl(inst)}
                                target="_blank"
                                rel="noreferrer"
                                title={
                                  inst.status === "ready"
                                    ? undefined
                                    : "Cluster is not fully up yet — this may not connect"
                                }
                              >
                                {inst.status === "ready" ? "Open" : "Open (not ready)"}
                              </a>
                            ) : (
                              <span className="mono">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
