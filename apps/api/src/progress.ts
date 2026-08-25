import type { ClusterHealth, DeploymentMode, InstanceStatus } from "./types.js";
import { normalizeClusters } from "./clusters.js";

export type StepState = "pending" | "active" | "done" | "failed";
export type OperationKind = "apply" | "destroy";

export interface ProgressStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

export interface ResourceSection {
  id: string;
  label: string;
  total: number;
  done: number;
  state: StepState;
  current?: string;
}

export interface Progress {
  operation: OperationKind;
  phase: string;
  phaseLabel: string;
  percent: number;
  resourcesDone: number;
  resourcesTotal: number;
  currentResource?: string;
  steps: ProgressStep[];
  sections: ResourceSection[];
  elapsedSeconds?: number;
}

export type AppWorkloadPlan = {
  name: string;
  steps: string[];
};

export type ProgressContext = {
  clusterNames?: string[];
  databaseCount?: number;
  licenseCount?: number;
  appWorkloads?: AppWorkloadPlan[];
};

export function clusterNamesFromConfig(
  config: Record<string, unknown> | undefined,
  mode: DeploymentMode,
): string[] {
  try {
    return normalizeClusters({ ...(config || {}), mode }).map((c) => c.name);
  } catch {
    return [];
  }
}

export function progressExtrasFromConfig(
  config: Record<string, unknown> | undefined,
  mode: DeploymentMode,
): ProgressContext {
  const cfg = config || {};
  let databaseCount = 0;
  let licenseCount = 0;
  try {
    const clusters = normalizeClusters({ ...cfg, mode });
    const raw = Array.isArray(cfg.clusters) ? (cfg.clusters as Record<string, unknown>[]) : [];
    clusters.forEach((_, i) => {
      const row = raw[i] || {};
      const dbs = Array.isArray(row.databases) ? row.databases : [];
      databaseCount += dbs.length;
      if (String(row.license || "").trim()) licenseCount += 1;
    });
  } catch {
    const raw = Array.isArray(cfg.clusters) ? (cfg.clusters as Record<string, unknown>[]) : [];
    for (const row of raw) {
      databaseCount += Array.isArray(row.databases) ? row.databases.length : 0;
      if (String(row.license || "").trim()) licenseCount += 1;
    }
  }

  const appWorkloads: AppWorkloadPlan[] = [];
  const apps = Array.isArray(cfg.applications) ? (cfg.applications as Record<string, unknown>[]) : [];
  for (const app of apps) {
    const name = String(app.name || "").trim();
    if (!name) continue;
    const artifact = (app.artifact || {}) as Record<string, unknown>;
    const reqs = Array.isArray(app.requirements) ? app.requirements.map(String) : [];
    const steps: string[] = [];
    if (artifact.kind === "git" || reqs.includes("git")) steps.push("clone");
    if (artifact.runInDocker === true || reqs.includes("docker")) steps.push("docker");
    if (String(app.command || "").trim()) steps.push("start");
    if (!steps.length) continue;
    appWorkloads.push({ name, steps });
  }

  return {
    clusterNames: clusterNamesFromConfig(cfg, mode),
    databaseCount,
    licenseCount,
    appWorkloads,
  };
}

// Ordered so the UI reflects the rough order Terraform works through them.
const SHARED_SECTION_DEFS: { id: string; label: string; match: (addr: string) => boolean }[] = [
  {
    id: "network",
    label: "Network (VPC, subnets, firewall)",
    match: (a) => a.includes("module.network"),
  },
  {
    id: "credentials",
    label: "Cluster credentials",
    match: (a) => a.includes("random_password"),
  },
  {
    id: "nodes",
    label: "Redis Enterprise nodes",
    match: (a) => a.includes("module.re_vm") && a.includes("google_compute_instance"),
  },
  {
    id: "dns",
    label: "DNS records",
    match: (a) => a.includes("module.re_vm") && a.includes("google_dns"),
  },
  {
    id: "app",
    label: "Application / memtier VM",
    match: (a) => a.includes("module.app_vm") || a.includes("module.app_workload"),
  },
  {
    id: "gke",
    label: "GKE cluster and node pool",
    match: (a) => a.includes("module.gke"),
  },
  {
    id: "operator",
    label: "Redis Enterprise Operator and REC",
    match: (a) => a.includes("module.re_k8s"),
  },
  {
    id: "apps_k8s",
    label: "Application workloads (k8s)",
    match: (a) => a.includes("module.app_k8s"),
  },
];

function shortAddr(addr: string): string {
  return addr.replace(/^module\.stack\./, "");
}

function reVmIndex(addr: string): number | null {
  const m = addr.match(/module\.re_vm\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

function clusterSectionLabel(index: number, names?: string[]): string {
  const name = names?.[index]?.trim();
  return name ? `Redis cluster ${name}` : `Redis cluster ${index + 1}`;
}

function sectionDefsFor(
  addrs: string[],
  clusterNames?: string[],
): { id: string; label: string; match: (addr: string) => boolean }[] {
  const fromLog = [...new Set(addrs.map(reVmIndex).filter((i): i is number => i !== null))];
  const namedCount = clusterNames?.length ?? 0;
  const clusterCount = Math.max(fromLog.length ? Math.max(...fromLog) + 1 : 0, namedCount);
  const multi = clusterCount > 1;
  const clusterDefs = multi
    ? Array.from({ length: clusterCount }, (_, i) => ({
        id: `cluster-${i}`,
        label: clusterSectionLabel(i, clusterNames),
        match: (a: string) => reVmIndex(a) === i,
      }))
    : [];
  const skipWhenSplit = new Set(multi ? ["credentials", "nodes", "dns"] : []);
  return [
    SHARED_SECTION_DEFS[0],
    ...clusterDefs,
    ...SHARED_SECTION_DEFS.slice(1).filter((d) => !skipWhenSplit.has(d.id)),
  ];
}

function classify(
  addr: string,
  defs: { id: string; label: string; match: (addr: string) => boolean }[],
): string {
  return defs.find((s) => s.match(addr))?.id ?? "other";
}

function collectAddresses(text: string): { planned: string[]; completed: string[]; inFlight: string[] } {
  return {
    planned: [...text.matchAll(/^\s*# (\S+) will be (?:created|destroyed)/gm)].map((m) =>
      shortAddr(m[1]),
    ),
    completed: [...text.matchAll(/^\s*(\S+): (?:Creation|Destruction) complete/gm)].map((m) =>
      shortAddr(m[1]),
    ),
    inFlight: [...text.matchAll(/^\s*(\S+): (?:Still )?(?:Creating|Destroying)\.\.\./gm)].map((m) =>
      shortAddr(m[1]),
    ),
  };
}

function collectSections(
  text: string,
  failed: boolean,
  clusterNames?: string[],
): ResourceSection[] {
  const totals = new Map<string, number>();
  const done = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  const { planned, completed, inFlight } = collectAddresses(text);
  const defs = sectionDefsFor([...planned, ...completed, ...inFlight], clusterNames);

  for (const addr of planned) bump(totals, classify(addr, defs));
  for (const addr of completed) bump(done, classify(addr, defs));

  const activeAddr = inFlight[inFlight.length - 1];
  const activeSection = activeAddr ? classify(activeAddr, defs) : undefined;

  const ids = [...new Set([...totals.keys(), ...done.keys()])];
  return defs
    .concat([{ id: "other", label: "Other resources", match: () => false }])
    .filter((def) => ids.includes(def.id))
    .map((def) => {
      const d = done.get(def.id) ?? 0;
      const total = Math.max(totals.get(def.id) ?? 0, d);
      const isActive = def.id === activeSection;
      let state: StepState;
      if (total > 0 && d >= total) state = "done";
      else if (isActive) state = failed ? "failed" : "active";
      else if (d > 0) state = "active";
      else state = "pending";
      return {
        id: def.id,
        label: def.label,
        total,
        done: d,
        state,
        current: isActive && state !== "done" ? activeAddr : undefined,
      };
    });
}

const APPLY_STEPS_VM = [
  { id: "init", label: "Initialize Terraform" },
  { id: "plan", label: "Plan infrastructure" },
  { id: "create", label: "Create VPC, nodes, DNS" },
  { id: "bootstrap", label: "Install Redis Enterprise on nodes" },
  { id: "ready", label: "Cluster endpoints available" },
];

const APPLY_STEPS_GKE = [
  { id: "init", label: "Initialize Terraform" },
  { id: "plan", label: "Plan infrastructure" },
  { id: "create", label: "Create VPC and GKE node pool" },
  { id: "operator", label: "Install Redis Enterprise Operator" },
  { id: "rec", label: "Wait for RedisEnterpriseCluster" },
  { id: "ready", label: "Cluster endpoints available" },
];

const DESTROY_STEPS = [
  { id: "init", label: "Initialize Terraform" },
  { id: "plan", label: "Plan teardown" },
  { id: "destroy", label: "Delete cloud resources" },
  { id: "destroyed", label: "All resources destroyed" },
];

const PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  init: "Initializing Terraform",
  plan: "Planning infrastructure",
  create: "Creating cloud resources",
  bootstrap: "Installing Redis Enterprise",
  operator: "Installing Redis Enterprise Operator",
  rec: "Waiting for Redis Enterprise Cluster",
  licenses: "Applying Redis licenses",
  databases: "Creating Redis databases",
  ready: "Ready",
  degraded: "Cluster did not fully form",
  destroy_plan: "Planning teardown",
  destroying: "Destroying resources",
  destroyed: "Destroyed",
  failed: "Failed",
};

const DESTROY_ORDER = ["init", "plan", "destroy", "destroyed"];

function applyStepDefs(
  mode: DeploymentMode,
  extras?: ProgressContext,
): { id: string; label: string }[] {
  const base = mode === "gke" ? APPLY_STEPS_GKE : APPLY_STEPS_VM;
  const extra: { id: string; label: string }[] = [];
  if ((extras?.licenseCount ?? 0) > 0) extra.push({ id: "licenses", label: "Apply Redis licenses" });
  if ((extras?.databaseCount ?? 0) > 0) extra.push({ id: "databases", label: "Create Redis databases" });
  if (!extra.length) return base;
  const readyIdx = base.findIndex((s) => s.id === "ready");
  return [...base.slice(0, readyIdx), ...extra, ...base.slice(readyIdx)];
}

function lastMatch(log: string, re: RegExp): string | undefined {
  const matches = log.match(re);
  return matches ? matches[matches.length - 1] : undefined;
}

// Terraform emits ANSI colour codes, including in the middle of the summary lines
// ("Plan: N to add") and before resource addresses, so they must go before matching.
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

// A single instance log accumulates every apply and destroy run, so progress must
// be computed from the most recent operation only. Otherwise a destroy inherits
// the previous apply's "Plan: N to add" and resource counters.
function lastOperation(log: string): {
  kind: OperationKind;
  text: string;
  startedAt?: string;
  finishedAt?: string;
} {
  const marker = /^=== (APPLY|DESTROY) START (.+) ===$/gm;
  let kind: OperationKind = "apply";
  let startedAt: string | undefined;
  let sliceFrom = 0;
  for (let m = marker.exec(log); m !== null; m = marker.exec(log)) {
    kind = m[1] === "DESTROY" ? "destroy" : "apply";
    startedAt = m[2].trim();
    sliceFrom = m.index + m[0].length;
  }
  const text = log.slice(sliceFrom);
  // An apply is only finished when the cluster is usable, which lands after
  // APPLY COMPLETE, so the reported duration is time-to-ready rather than
  // time-to-terraform-exit.
  const ready = /^=== CLUSTER READY (\S+) .*===$/m.exec(text);
  const done = /^=== (?:APPLY|DESTROY) COMPLETE (.+) ===$/m.exec(text);
  return {
    kind,
    text,
    startedAt,
    finishedAt: ready?.[1]?.trim() ?? done?.[1]?.trim(),
  };
}

function buildSteps(
  defs: { id: string; label: string }[],
  order: string[],
  phase: string,
  failed: boolean,
  terminalPhase: string,
): ProgressStep[] {
  const steps: ProgressStep[] = defs.map((s) => ({ ...s, state: "pending" }));
  if (phase === terminalPhase) {
    return steps.map((s) => ({ ...s, state: "done" }));
  }
  // A failure has no phase of its own; it is shown on the step that was running.
  const activeIdx = order.indexOf(phase);
  if (activeIdx < 0) return steps;
  order.forEach((id, idx) => {
    const target = steps.find((s) => s.id === id);
    if (!target) return;
    if (idx < activeIdx) target.state = "done";
    else if (idx === activeIdx) target.state = failed ? "failed" : "active";
  });
  return steps;
}

function destroyProgress(
  text: string,
  status: InstanceStatus,
  failed: boolean,
): Omit<Progress, "elapsedSeconds" | "operation" | "sections"> {
  const planMatch = /Plan: \d+ to add, \d+ to change, (\d+) to destroy/.exec(text);
  const resourcesTotal = planMatch ? Number(planMatch[1]) : 0;
  const summary = /Destroy complete! Resources: (\d+) destroyed/.exec(text);
  const destructions = (text.match(/Destruction complete after/g) || []).length;
  const resourcesDone = summary ? Number(summary[1]) : destructions;

  const destroying = lastMatch(text, /^\s*([\w.\[\]"-]+): (?:Still )?Destroying\.\.\./gm);
  const currentResource = destroying
    ? destroying.trim().split(":")[0].replace(/^module\.stack\./, "")
    : undefined;

  let phase: string;
  if (summary || status === "destroyed") {
    phase = "destroyed";
  } else if (destructions > 0 || /: Destroying\.\.\./.test(text)) {
    phase = "destroy";
  } else if (/Plan: |Refreshing state|Reading\.\.\./.test(text)) {
    phase = "plan";
  } else {
    phase = "init";
  }

  const steps = buildSteps(DESTROY_STEPS, DESTROY_ORDER, phase, failed, "destroyed");
  const destroyStep = steps.find((s) => s.id === "destroy");
  if (destroyStep && resourcesTotal > 0) {
    destroyStep.detail = `${Math.min(resourcesDone, resourcesTotal)} of ${resourcesTotal} resources deleted`;
  }
  if (currentResource && destroyStep?.state === "active") {
    destroyStep.detail = `${Math.min(resourcesDone, resourcesTotal)} of ${resourcesTotal || "?"} · ${currentResource}`;
  }

  let percent: number;
  if (phase === "destroyed") {
    percent = 100;
  } else if (phase === "destroy" && resourcesTotal > 0) {
    percent = 20 + Math.min(1, resourcesDone / resourcesTotal) * 75;
  } else {
    percent = { init: 5, plan: 15, destroy: 20 }[phase] ?? 5;
  }

  return {
    phase: phase === "plan" ? "destroy_plan" : phase === "destroy" ? "destroying" : phase,
    phaseLabel:
      PHASE_LABELS[phase === "plan" ? "destroy_plan" : phase === "destroy" ? "destroying" : phase] ??
      phase,
    percent,
    resourcesDone,
    resourcesTotal,
    currentResource,
    steps,
  };
}

function applyProgress(
  text: string,
  status: InstanceStatus,
  mode: DeploymentMode,
  failed: boolean,
  health?: ClusterHealth,
  extras?: ProgressContext,
): Omit<Progress, "elapsedSeconds" | "operation" | "sections"> {
  const planMatch = /Plan: (\d+) to add/.exec(text);
  const resourcesTotal = planMatch ? Number(planMatch[1]) : 0;
  const resourcesDone = (text.match(/Creation complete after/g) || []).length;

  const creating = lastMatch(text, /^\s*([\w.\[\]"-]+): (?:Still )?Creating\.\.\./gm);
  const currentResource = creating
    ? creating.trim().split(":")[0].replace(/^module\.stack\./, "")
    : undefined;

  const settleStep = mode === "gke" ? "rec" : "bootstrap";
  const degraded = status === "degraded";
  const hasLicenses = (extras?.licenseCount ?? 0) > 0;
  const hasDatabases = (extras?.databaseCount ?? 0) > 0;
  const resourcesComplete = /=== CLUSTER RESOURCES COMPLETE/.test(text);
  const clusterReadyMarked = /=== CLUSTER READY/.test(text) || health?.state === "ready";
  const creatingDatabases = /=== CREATING DATABASES/.test(text);
  const applyingLicenses = /=== APPLYING LICENSES/.test(text);

  let phase: string;
  if (status === "ready" || resourcesComplete) {
    phase = "ready";
  } else if (hasDatabases && creatingDatabases) {
    phase = "databases";
  } else if (hasLicenses && (applyingLicenses || (clusterReadyMarked && !creatingDatabases))) {
    phase = "licenses";
  } else if (hasDatabases && clusterReadyMarked) {
    phase = "databases";
  } else if (status === "bootstrapping" || degraded) {
    phase = settleStep;
  } else if (/Apply complete/.test(text)) {
    phase = settleStep;
  } else if (/Waiting for REC|kubectl get rec|RedisEnterpriseCluster/.test(text)) {
    phase = "rec";
  } else if (/helm (?:upgrade|repo)|redis-enterprise-operator/.test(text)) {
    phase = "operator";
  } else if (resourcesDone > 0 || /: Creating\.\.\./.test(text)) {
    phase = "create";
  } else if (/Terraform used the selected providers|Plan: |Refreshing state/.test(text)) {
    phase = "plan";
  } else if (/terraform init|Initializing (?:the backend|modules|provider)/.test(text)) {
    phase = "init";
  } else {
    phase = "queued";
  }

  const defs = applyStepDefs(mode, extras);
  const order = defs.map((s) => s.id);
  const steps = buildSteps(defs, order, phase, failed || degraded, "ready");

  const createStep = steps.find((s) => s.id === "create");
  if (createStep && resourcesTotal > 0) {
    createStep.detail = `${Math.min(resourcesDone, resourcesTotal)} of ${resourcesTotal} resources`;
  }

  const settle = steps.find((s) => s.id === settleStep);
  if (settle && health && phase === settleStep) {
    settle.detail = health.detail;
  }

  const dbHits = [...text.matchAll(/database \S+\/\S+ (ready|FAILED)/g)];
  const dbStep = steps.find((s) => s.id === "databases");
  if (dbStep && hasDatabases) {
    dbStep.detail = `${Math.min(dbHits.length, extras?.databaseCount || 0)} of ${extras?.databaseCount} databases`;
  }

  const licHits = [...text.matchAll(/license (?:applied|FAILED)/g)];
  const licStep = steps.find((s) => s.id === "licenses");
  if (licStep && hasLicenses) {
    licStep.detail = `${Math.min(licHits.length, extras?.licenseCount || 0)} of ${extras?.licenseCount} licenses`;
  }

  const postBootstrap = hasLicenses || hasDatabases;
  let percent: number;
  if (phase === "ready") {
    percent = 100;
  } else if (phase === "databases") {
    const total = Math.max(1, extras?.databaseCount || 1);
    percent = 86 + Math.min(1, dbHits.length / total) * 10;
  } else if (phase === "licenses") {
    const total = Math.max(1, extras?.licenseCount || 1);
    percent = 78 + Math.min(1, licHits.length / total) * 6;
  } else if (phase === settleStep) {
    const ratio =
      health && health.nodesExpected > 0
        ? Math.min(1, health.nodesActive / health.nodesExpected)
        : 0;
    percent = postBootstrap ? 55 + ratio * 22 : 80 + ratio * 18;
  } else if (phase === "create" && resourcesTotal > 0) {
    percent = 25 + Math.min(1, resourcesDone / resourcesTotal) * (postBootstrap ? 28 : mode === "gke" ? 40 : 65);
  } else {
    percent = { queued: 2, init: 8, plan: 15, create: 25, operator: 70 }[phase] ?? 5;
  }

  return {
    phase: degraded ? "degraded" : phase,
    phaseLabel: degraded ? PHASE_LABELS.degraded : (PHASE_LABELS[phase] ?? phase),
    percent,
    resourcesDone,
    resourcesTotal,
    currentResource,
    steps,
  };
}

function databaseSection(text: string, extras?: ProgressContext, failed?: boolean): ResourceSection | undefined {
  const total = extras?.databaseCount ?? 0;
  if (total <= 0) return undefined;
  const hits = [...text.matchAll(/database (\S+)\/(\S+) (ready|FAILED)/g)];
  const done = Math.min(hits.length, total);
  const anyFailed = hits.some((m) => m[3] === "FAILED");
  const started = /=== CREATING DATABASES/.test(text) || hits.length > 0;
  let state: StepState = "pending";
  if (failed && started) state = "failed";
  else if (done >= total && total > 0) state = anyFailed ? "failed" : "done";
  else if (started) state = "active";
  return {
    id: "databases",
    label: "Redis databases",
    total,
    done,
    state,
    current: started && state === "active" ? hits[hits.length - 1]?.[0] : undefined,
  };
}

function appWorkloadSections(
  text: string,
  extras?: ProgressContext,
  failed?: boolean,
  complete?: boolean,
): ResourceSection[] {
  const plans = extras?.appWorkloads ?? [];
  if (!plans.length) return [];
  const seen = new Map<string, Set<string>>();
  const finished = new Set<string>();
  for (const m of text.matchAll(/=== APPWL (\S+) STEP (\S+) ===/g)) {
    const name = m[1];
    const step = m[2];
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name)!.add(step);
  }
  for (const m of text.matchAll(/=== APPWL (\S+) DONE ===/g)) {
    finished.add(m[1]);
  }
  return plans.map((plan) => {
    const id = `appwl-${plan.name}`;
    const total = plan.steps.length;
    const got = seen.get(plan.name) || new Set();
    const done = finished.has(plan.name) || complete ? total : Math.min(got.size, total);
    const started = got.size > 0 || finished.has(plan.name);
    let state: StepState = "pending";
    if (failed && started) state = "failed";
    else if (done >= total) state = "done";
    else if (started) state = "active";
    const currentStep = plan.steps.find((s) => !got.has(s));
    return {
      id,
      label: `Application ${plan.name}`,
      total,
      done,
      state,
      current: state === "active" && currentStep ? currentStep : undefined,
    };
  });
}

export function computeProgress(
  log: string,
  status: InstanceStatus,
  mode: DeploymentMode,
  startedAt?: string,
  health?: ClusterHealth,
  ctx?: ProgressContext,
): Progress {
  const op = lastOperation(stripAnsi(log));
  const kind: OperationKind =
    status === "destroying" || status === "destroyed" ? "destroy" : op.kind;
  const failed = status === "failed";
  const settling = status === "bootstrapping";

  const core =
    kind === "destroy"
      ? destroyProgress(op.text, status, failed)
      : applyProgress(op.text, status, mode, failed, health, ctx);

  const startedMs = new Date(op.startedAt ?? startedAt ?? "").getTime();
  const endedMs = op.finishedAt && !settling ? new Date(op.finishedAt).getTime() : Date.now();
  const elapsedSeconds = Number.isNaN(startedMs)
    ? undefined
    : Math.max(0, Math.round((endedMs - startedMs) / 1000));

  const complete = core.percent >= 100;
  const sections = collectSections(op.text, failed, ctx?.clusterNames).map((s) =>
    complete ? { ...s, state: "done" as StepState, current: undefined } : s,
  );

  if (kind === "apply" && health && status !== "failed") {
    const clusterDone = health.state === "ready";
    sections.push({
      id: "redis",
      label: mode === "gke" ? "Redis Enterprise cluster (REC)" : "Redis Enterprise cluster",
      total: health.nodesExpected,
      done: clusterDone ? health.nodesExpected : health.nodesActive,
      state: clusterDone ? "done" : status === "degraded" ? "failed" : "active",
      current: clusterDone ? undefined : health.detail,
    });
  }

  const dbs = databaseSection(op.text, ctx, failed);
  if (dbs) {
    sections.push(complete ? { ...dbs, state: dbs.state === "failed" ? "failed" : "done", current: undefined } : dbs);
  }

  for (const app of appWorkloadSections(op.text, ctx, failed, complete)) {
    sections.push(complete && app.state !== "failed" ? { ...app, state: "done", current: undefined } : app);
  }

  return {
    operation: kind,
    ...core,
    phaseLabel: failed ? PHASE_LABELS.failed : core.phaseLabel,
    percent: Math.round(failed ? Math.min(core.percent, 95) : core.percent),
    currentResource: complete ? undefined : core.currentResource,
    sections,
    elapsedSeconds,
  };
}
