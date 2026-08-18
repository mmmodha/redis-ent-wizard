"use client";

import type { ReactNode } from "react";
import {
  ACCESS_ENDPOINT_KEYS,
  buildAccessView,
  type AccessAppVm,
  type AccessCluster,
  type AccessView,
} from "@/lib/access";

const HIDDEN_OUTPUTS = new Set(["deployment_mode", "k8s_outputs_file", ...ACCESS_ENDPOINT_KEYS]);

function copy(text: string) {
  void navigator.clipboard.writeText(text);
}

function Field({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href?: string;
  hint?: string;
}) {
  if (!value) return null;
  return (
    <div className="endpoint-row">
      <div className="mono">{label}</div>
      <code>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
        {hint ? <div className="hint">{hint}</div> : null}
      </code>
      <button className="btn" type="button" onClick={() => copy(value)}>
        Copy
      </button>
    </div>
  );
}

function ClusterFields({ cluster }: { cluster: AccessCluster }) {
  return (
    <div>
      <Field
        label="Cluster DNS"
        value={cluster.clusterDns}
        hint="Redis Enterprise cluster name (NS). It is not a website — open the UI on node1 port 8443."
      />
      <Field label="Cluster UI" value={cluster.uiUrl} href={cluster.uiUrl} />
      <Field label="UI (IP)" value={cluster.uiIpUrl} href={cluster.uiIpUrl} />
      <Field label="Machine type" value={cluster.machineType} />
      <Field label="Username" value={cluster.adminUsername} />
      <Field label="Password" value={cluster.adminPassword} />
      {cluster.nodes.map((node, i) => (
        <div className="access-node" key={node.name || `${cluster.id}-n${i}`}>
          <div className="access-node-title mono">{node.name || `Node ${i + 1}`}</div>
          <Field label="DNS" value={node.dns} href={node.dns ? `https://${node.dns}:8443` : undefined} />
          <Field label="IP" value={node.ip} href={node.ip ? `https://${node.ip}:8443` : undefined} />
          <Field label="Zone" value={node.zone} />
          <Field label="How to SSH" value={node.ssh} />
        </div>
      ))}
    </div>
  );
}

function AppFields({ app }: { app: AccessAppVm }) {
  return (
    <div>
      <Field label="Name" value={app.name} />
      <Field label="DNS" value={app.dns} href={app.httpUrl || undefined} />
      <Field label="IP" value={app.ip} />
      <Field label="Machine type" value={app.machineType} />
      <Field label="Zone" value={app.zone} />
      <Field label="How to SSH" value={app.ssh} />
      <Field label="HTTP" value={app.httpUrl} href={app.httpUrl} />
      <Field label="HTTPS" value={app.httpsUrl} href={app.httpsUrl} />
    </div>
  );
}

function clusterSummary(cluster: AccessCluster): string {
  const bits = [
    cluster.nodeCount ? `${cluster.nodeCount} node${cluster.nodeCount === 1 ? "" : "s"}` : "",
    cluster.machineType,
    cluster.clusterDns,
  ].filter(Boolean);
  return bits.join(" · ");
}

function appSummary(app: AccessAppVm): string {
  return [app.machineType, app.dns || app.ip].filter(Boolean).join(" · ");
}

function AccessList<T extends { id: string; label: string }>({
  title,
  items,
  kind,
  summary,
  render,
}: {
  title: string;
  items: T[];
  kind: "cluster" | "app";
  summary: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div className="access-section">
      <h3>{title}</h3>
      <div className="access-accordions">
        {items.map((item) => {
          const meta = summary(item);
          return (
            <details
              key={item.id}
              className={`access-accordion access-accordion-${kind}`}
              open={items.length === 1}
            >
              <summary>
                <span className="access-accordion-label">{item.label}</span>
                {meta ? <span className="access-accordion-meta mono">{meta}</span> : null}
              </summary>
              <div className="access-accordion-body">{render(item)}</div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function leftoverRows(endpoints: Record<string, unknown>) {
  return Object.entries(endpoints).filter(
    ([k, v]) => !HIDDEN_OUTPUTS.has(k) && v !== "" && v !== null && v !== undefined,
  );
}

function toLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//.test(value)) return value;
  return null;
}

export function AccessPanel({
  endpoints,
  mode,
  region,
  regionZones,
  machineType,
  access,
}: {
  endpoints: Record<string, unknown>;
  mode: "vm" | "gke";
  region: string;
  regionZones?: string[];
  machineType?: string;
  access?: AccessView;
}) {
  const view =
    access && (access.clusters.length || access.apps.length || access.kubectl)
      ? access
      : buildAccessView(endpoints, {
          mode,
          region,
          region_zones: regionZones,
          machine_type: machineType,
        });
  const extra = leftoverRows(endpoints);
  const empty = !view.clusters.length && !view.apps.length && !view.kubectl && !extra.length;
  if (empty) return <div className="empty">Endpoints appear when apply completes.</div>;

  return (
    <div>
      {view.kubectl ? <Field label="kubectl" value={view.kubectl} /> : null}
      <AccessList
        title={mode === "gke" ? "Redis Enterprise clusters" : "Redis clusters"}
        items={view.clusters}
        kind="cluster"
        summary={clusterSummary}
        render={(cluster) => <ClusterFields cluster={cluster} />}
      />
      <AccessList
        title="App VMs"
        items={view.apps}
        kind="app"
        summary={appSummary}
        render={(app) => <AppFields app={app} />}
      />
      {extra.map(([key, value]) => {
        const text = Array.isArray(value) ? value.join("\n") : String(value);
        const urls = (Array.isArray(value) ? value : [value])
          .map(String)
          .map(toLink)
          .filter((v): v is string => v !== null);
        return (
          <div className="endpoint-row" key={key}>
            <div className="mono">{key}</div>
            <code>
              {urls.length ? (
                urls.map((u) => (
                  <div key={u}>
                    <a href={u} target="_blank" rel="noreferrer">
                      {u}
                    </a>
                  </div>
                ))
              ) : (
                text
              )}
            </code>
            <button className="btn" type="button" onClick={() => copy(text)}>
              Copy
            </button>
          </div>
        );
      })}
    </div>
  );
}
