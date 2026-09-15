"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";

import { CheckList } from "@/components/CheckList";
import { DeploymentSettings, ownerError, type DesignMeta } from "@/components/design/DeploymentSettings";
import { DesignView } from "@/components/create/DesignView";
import { WizardView } from "@/components/create/WizardView";
import { createInstance, getInstance, runPreflight, saveDesign, type PreflightResult } from "@/lib/api";
import { useGcpLookups } from "@/lib/useGcpLookups";
import { canUseDesignerCanvas, designerLockReason } from "@/lib/designer-gate";
import { clusterTrialShardGate, omitCreateInputDatabases } from "@/lib/trial-shards";
import type { DesignSettings } from "@/lib/diagram";

type View = "wizard" | "diagram";
const VIEW_STORAGE_KEY = "rew:editView";

/** Settings fields the shell owns; overlaid onto the active view's config on submit. */
const SETTINGS_KEYS = [
  "name",
  "env",
  "folder",
  "youremail",
  "skip_deletion",
  "project",
  "credentialsFile",
  "region_name",
  "region_zones",
  "mode",
  "RS_admin",
  "operator_chart_version",
  "dns_managed_zone",
  "dns_zone_dns_name",
] as const;

/**
 * The unified create workspace: shared deployment settings + a Wizard⇄Diagram
 * toggle over one create config, with a single preflight/apply action bar. Pass
 * `lockedView` to render a single view without the toggle (legacy /wizard, /design).
 */
export function EditWorkspace({ lockedView }: { lockedView?: View }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");
  const viewParam = searchParams.get("view");
  const hydratedRef = useRef(false);
  const gcp = useGcpLookups();

  const [meta, setMeta] = useState<DesignMeta>({
    name: "",
    env: "default",
    folder: "",
    youremail: "",
    skip_deletion: false,
    mode: "vm",
    RS_admin: "admin@redis.io",
    operator_chart_version: "latest",
  });

  const [view, setView] = useState<View>(() => {
    if (lockedView) return lockedView;
    if (viewParam === "wizard" || viewParam === "diagram") return viewParam;
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "wizard" || stored === "diagram") return stored;
    }
    return "wizard";
  });

  const [currentConfig, setCurrentConfig] = useState<Record<string, unknown> | null>(null);
  // Bumped when new hydration input is ready (a ?from load, or a view switch),
  // so the mounted view remounts and re-reads `hydrationRef`.
  const [hydrationToken, setHydrationToken] = useState(0);
  const [isUploading, setUploading] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savedDraftId, setSavedDraftId] = useState("");
  const [error, setError] = useState("");

  // Config the active view hydrates from. Frozen while a view is mounted (it is
  // read once on mount); the shell swaps views by remounting via `key`.
  const hydrationRef = useRef<Record<string, unknown> | null>(null);

  const settings: DesignSettings = useMemo(
    () => ({
      name: meta.name,
      env: meta.env,
      folder: meta.folder,
      youremail: meta.youremail,
      skip_deletion: meta.skip_deletion,
      mode: meta.mode,
      RS_admin: meta.RS_admin,
      operator_chart_version: meta.operator_chart_version,
      credentialsFile: gcp.settings.credentialsFile,
      project: gcp.settings.project,
      region_name: gcp.settings.region_name,
      region_zones: gcp.settings.region_zones,
      dns_managed_zone: gcp.settings.dns_managed_zone,
      dns_zone_dns_name: gcp.settings.dns_zone_dns_name,
    }),
    [meta, gcp.settings],
  );

  const validCredential = gcp.credentials.find((c) => c.file === gcp.settings.credentialsFile)?.valid;
  const canvasReady = canUseDesignerCanvas({
    credentialsFile: gcp.settings.credentialsFile,
    credentialValid: validCredential,
  });
  const diagramLockReason = designerLockReason({
    credentialsFile: gcp.settings.credentialsFile,
    credentialValid: validCredential,
  });

  const switchMode = useCallback((mode: "vm" | "gke") => {
    setMeta((m) => ({ ...m, mode }));
    setPreflight(null);
  }, []);

  const switchView = useCallback(
    (next: View) => {
      if (next === view || isUploading) return;
      // The active view keeps currentConfig fresh; hand it to the next view.
      hydrationRef.current = currentConfig;
      setView(next);
      setHydrationToken((t) => t + 1);
      setPreflight(null);
      if (typeof window !== "undefined") window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    },
    [view, isUploading, currentConfig],
  );

  const onConfigChange = useCallback((config: Record<string, unknown>) => {
    setCurrentConfig(config);
    setPreflight(null);
  }, []);

  // Reopen a destroyed instance's config for editing (?from=<id>). Runs once.
  const gcpSetSettings = gcp.setSettings;
  useEffect(() => {
    if (!fromId || hydratedRef.current) return;
    hydratedRef.current = true;
    getInstance(fromId)
      .then((inst) => {
        const cfg = (inst.config || {}) as Record<string, unknown>;
        const s = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
        const mode: "vm" | "gke" = cfg.mode === "gke" ? "gke" : "vm";
        setMeta((m) => ({
          ...m,
          name: s(cfg.name, m.name),
          env: s(cfg.env, m.env),
          folder: typeof cfg.folder === "string" ? cfg.folder : m.folder,
          youremail: s(cfg.youremail, m.youremail),
          skip_deletion: Boolean(cfg.skip_deletion),
          mode,
          RS_admin: s(cfg.RS_admin, m.RS_admin),
          operator_chart_version: s(cfg.operator_chart_version, m.operator_chart_version),
        }));
        const zones = Array.isArray(cfg.region_zones) ? (cfg.region_zones as unknown[]).map(String) : [];
        gcpSetSettings((st) => ({
          ...st,
          credentialsFile: inst.credentialsId || "",
          project: s(cfg.project, st.project),
          region_name: s(cfg.region_name, st.region_name),
          region_zones: zones.length ? zones : st.region_zones,
          dns_managed_zone: s(cfg.dns_managed_zone, st.dns_managed_zone),
          dns_zone_dns_name: s(cfg.dns_zone_dns_name, st.dns_zone_dns_name),
        }));
        hydrationRef.current = cfg;
        setCurrentConfig(cfg);
        // Remount the mounted view so it re-reads the freshly hydrated config.
        setHydrationToken((t) => t + 1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load instance for editing"));
  }, [fromId, gcpSetSettings]);

  const withSettings = useCallback(
    (cfg: Record<string, unknown>): Record<string, unknown> => {
      const overlay: Record<string, unknown> = { ...cfg };
      for (const k of SETTINGS_KEYS) overlay[k] = (settings as Record<string, unknown>)[k];
      return overlay;
    },
    [settings],
  );

  const trialShardBlocks = useMemo(() => {
    const clusters = Array.isArray(currentConfig?.clusters) ? (currentConfig!.clusters as Record<string, unknown>[]) : [];
    return clusters
      .map((c, i) =>
        clusterTrialShardGate({
          name: (typeof c.name === "string" && c.name) || `cluster ${i + 1}`,
          license: typeof c.license === "string" ? c.license : undefined,
          databases: Array.isArray(c.databases) ? (c.databases as { memory_gb?: number; sharding?: boolean; shards_count?: number; replication?: boolean }[]) : [],
          nodes: Number(meta.mode === "gke" ? c.rec_nodes ?? c.nodes : c.nodes ?? c.rec_nodes) || 0,
        }),
      )
      .filter((g) => g.blocked);
  }, [currentConfig, meta.mode]);

  const oe = ownerError(meta.youremail);
  const hasCluster = Array.isArray(currentConfig?.clusters) && (currentConfig!.clusters as unknown[]).length > 0;
  const hasAppWorkload =
    (Number(currentConfig?.app) || 0) > 0 ||
    (Array.isArray(currentConfig?.applications) && (currentConfig!.applications as unknown[]).length > 0);
  const topologyOk = meta.mode === "gke" ? hasCluster : hasCluster || hasAppWorkload;
  const canValidate = Boolean(
    meta.name && !oe && validCredential && gcp.settings.project && gcp.settings.region_name && topologyOk && currentConfig,
  );

  const validate = useCallback(async () => {
    if (!currentConfig) return;
    setChecking(true);
    setError("");
    try {
      setPreflight(await runPreflight(withSettings(currentConfig)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight failed");
    } finally {
      setChecking(false);
    }
  }, [currentConfig, withSettings]);

  const create = useCallback(async () => {
    if (!currentConfig) return;
    setSubmitting(true);
    setError("");
    try {
      const created = await createInstance(withSettings(currentConfig));
      router.push(`/instances/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSubmitting(false);
    }
  }, [currentConfig, withSettings, router]);

  const createWithoutDatabases = useCallback(async () => {
    if (!currentConfig) return;
    if (!confirm("Create the cluster without databases? You can apply a license later and create the databases from the instance page.")) {
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const input = omitCreateInputDatabases(withSettings(currentConfig));
      const pf = await runPreflight(input);
      setPreflight(pf);
      if (!pf.ok) {
        setSubmitting(false);
        return;
      }
      const created = await createInstance(input);
      router.push(`/instances/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSubmitting(false);
    }
  }, [currentConfig, withSettings, router]);

  const saveDraft = useCallback(async () => {
    if (!currentConfig) return;
    setSavingDraft(true);
    setError("");
    setSavedDraftId("");
    try {
      // Drafts persist the config without provisioning; no preflight required.
      const saved = await saveDesign(withSettings(currentConfig));
      setSavedDraftId(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft");
    } finally {
      setSavingDraft(false);
    }
  }, [currentConfig, withSettings]);

  const diagramDisabled = !canvasReady;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">Wizard</p>
          <h2 className="page-title">{fromId ? "Edit infrastructure" : "Create infrastructure"}</h2>
          <p className="page-sub">
            {fromId ? (
              <>
                Editing <span className="mono">{fromId}</span> — adjust in the guided wizard or on the
                canvas, then validate and apply.
              </>
            ) : (
              "Fill in the guided wizard or draw it on the canvas — switch views anytime; both build the same deployment."
            )}
          </p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {gcp.error ? <div className="error">{gcp.error}</div> : null}

      <div className="panel design-settings-panel">
        <DeploymentSettings
          gcp={gcp}
          meta={meta}
          onModeChange={switchMode}
          setMeta={(u) => {
            setMeta(u);
            setPreflight(null);
          }}
        />
      </div>

      {!lockedView ? (
        <div className="edit-view-toggle" role="tablist" aria-label="Editor view">
          <button
            type="button"
            role="tab"
            aria-selected={view === "wizard"}
            className={`chip ${view === "wizard" ? "chip-active" : ""}`}
            disabled={isUploading}
            onClick={() => switchView("wizard")}
          >
            Wizard
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "diagram"}
            className={`chip ${view === "diagram" ? "chip-active" : ""}`}
            disabled={isUploading || diagramDisabled}
            title={diagramDisabled ? diagramLockReason : undefined}
            onClick={() => switchView("diagram")}
          >
            Diagram
          </button>
          {isUploading ? <span className="hint">Finish the artifact upload before switching views.</span> : null}
        </div>
      ) : null}

      {view === "diagram" ? (
        <ReactFlowProvider>
          <DesignView
            key={`diagram-${hydrationToken}`}
            gcp={gcp}
            settings={settings}
            initialConfig={hydrationRef.current}
            onConfigChange={onConfigChange}
            onUploadingChange={setUploading}
          />
        </ReactFlowProvider>
      ) : (
        <WizardView
          key={`wizard-${hydrationToken}`}
          gcp={gcp}
          settings={settings}
          initialConfig={hydrationRef.current}
          onConfigChange={onConfigChange}
          onUploadingChange={setUploading}
        />
      )}

      {trialShardBlocks.length ? (
        <div className="notice notice-warn design-warn">
          {trialShardBlocks.map((g) => (
            <p key={g.message} style={{ margin: "0 0 8px" }}>
              {g.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="panel design-validate">
        <div className="review-head">
          <div>
            <h3 style={{ margin: "0 0 4px" }}>
              {meta.name || "instance"}-{meta.env}
            </h3>
            <p className="hint" style={{ margin: 0 }}>
              {meta.mode.toUpperCase()} · {gcp.settings.project || "no project"} ·{" "}
              {gcp.settings.region_name || "no region"}
            </p>
          </div>
          <button type="button" className="btn" onClick={validate} disabled={!canValidate || checking}>
            {checking ? "Validating…" : "Validate"}
          </button>
        </div>

        {!topologyOk ? (
          <p className="hint">
            {meta.mode === "gke"
              ? "Add a Redis Enterprise cluster to deploy on GKE."
              : "Add a Redis cluster, a set of VMs, or an application to deploy."}
          </p>
        ) : null}

        {checking && !preflight ? <div className="empty">Validating against GCP…</div> : null}
        {preflight ? <CheckList checks={preflight.checks} /> : null}
        {preflight && !preflight.ok ? (
          <div className="error">Fix the failed checks above before applying. Nothing has been created yet.</div>
        ) : null}

        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting || checking || !preflight?.ok}
            onClick={create}
          >
            {submitting ? "Starting…" : "Apply with Terraform"}
          </button>
          {trialShardBlocks.length ? (
            <button
              type="button"
              className="btn"
              disabled={submitting || checking}
              onClick={() => void createWithoutDatabases()}
            >
              Apply without databases
            </button>
          ) : null}
          {/* Persist the current config as a draft without provisioning. A draft
              is work-in-progress, so it only needs a valid name + owner. */}
          <button
            type="button"
            className="btn"
            disabled={savingDraft || submitting || !meta.name || Boolean(oe) || !currentConfig}
            onClick={() => void saveDraft()}
          >
            {savingDraft ? "Saving…" : "Save draft"}
          </button>
        </div>

        {savedDraftId ? (
          <p className="notice">
            Saved draft <span className="mono">{savedDraftId}</span> — no resources were created. Find it
            on the <Link href="/">Instances board</Link> to reopen or apply later.
          </p>
        ) : null}
      </div>
    </div>
  );
}
