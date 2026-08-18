import type { ClusterHealth, DeploymentMode, InstanceStatus } from "./types.js";

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

// Ordered so the UI reflects the rough order Terraform works through them.
const SECTION_DEFS: { id: string; label: string; match: (addr: string) => boolean }[] = [
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
    match: (a) => a.includes("module.app_vm"),
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
];

function shortAddr(addr: string): string {
  return addr.replace(/^module\.stack\./, "");
}

function classify(addr: string): string {
  return SECTION_DEFS.find((s) => s.match(addr))?.id ?? "other";
}

function collectSections(text: string, failed: boolean): ResourceSection[] {
  const totals = new Map<string, number>();
  const done = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  // Terraform enumerates every resource in the plan before acting on it.
  const planned = text.matchAll(/^\s*# (\S+) will be (?:created|destroyed)/gm);
  for (const m of planned) bump(totals, classify(shortAddr(m[1])));

  const completed = text.matchAll(/^\s*(\S+): (?:Creation|Destruction) complete/gm);
  for (const m of completed) bump(done, classify(shortAddr(m[1])));

  const inFlight = [...text.matchAll(/^\s*(\S+): (?:Still )?(?:Creating|Destroying)\.\.\./gm)];
  const last = inFlight[inFlight.length - 1];
  const activeAddr = last ? shortAddr(last[1]) : undefined;
  const activeSection = activeAddr ? classify(activeAddr) : undefined;

  const ids = [...new Set([...totals.keys(), ...done.keys()])];
  return SECTION_DEFS.concat([{ id: "other", label: "Other resources", match: () => false }])
    .filter((def) => ids.includes(def.id))
    .map((def) => {
      const d = done.get(def.id) ?? 0;
      // Without a plan enumeration, fall back to what has been observed.
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
  ready: "Ready",
  degraded: "Cluster did not fully form",
  destroy_plan: "Planning teardown",
  destroying: "Destroying resources",
  destroyed: "Destroyed",
  failed: "Failed",
};

const APPLY_ORDER_VM = ["init", "plan", "create", "bootstrap", "ready"];
const APPLY_ORDER_GKE = ["init", "plan", "create", "operator", "rec", "ready"];
const DESTROY_ORDER = ["init", "plan", "destroy", "destroyed"];

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
): Omit<Progress, "elapsedSeconds" | "operation" | "sections"> {
  const planMatch = /Plan: (\d+) to add/.exec(text);
  const resourcesTotal = planMatch ? Number(planMatch[1]) : 0;
  const resourcesDone = (text.match(/Creation complete after/g) || []).length;

  const creating = lastMatch(text, /^\s*([\w.\[\]"-]+): (?:Still )?Creating\.\.\./gm);
  const currentResource = creating
    ? creating.trim().split(":")[0].replace(/^module\.stack\./, "")
    : undefined;

  // Terraform finishing is not readiness: the software install happens after.
  const settleStep = mode === "gke" ? "rec" : "bootstrap";
  const degraded = status === "degraded";

  let phase: string;
  if (status === "ready") {
    phase = "ready";
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

  const defs = mode === "gke" ? APPLY_STEPS_GKE : APPLY_STEPS_VM;
  const order = mode === "gke" ? APPLY_ORDER_GKE : APPLY_ORDER_VM;
  const steps = buildSteps(defs, order, phase, failed || degraded, "ready");

  const createStep = steps.find((s) => s.id === "create");
  if (createStep && resourcesTotal > 0) {
    createStep.detail = `${Math.min(resourcesDone, resourcesTotal)} of ${resourcesTotal} resources`;
  }

  const settle = steps.find((s) => s.id === settleStep);
  if (settle && health && phase === settleStep) {
    settle.detail = health.detail;
  }

  let percent: number;
  if (phase === "ready") {
    percent = 100;
  } else if (phase === settleStep) {
    // Reserve the last stretch of the bar for the install/cluster-forming wait.
    const ratio =
      health && health.nodesExpected > 0
        ? Math.min(1, health.nodesActive / health.nodesExpected)
        : 0;
    percent = 80 + ratio * 18;
  } else if (phase === "create" && resourcesTotal > 0) {
    percent = 25 + Math.min(1, resourcesDone / resourcesTotal) * (mode === "gke" ? 40 : 65);
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

export function computeProgress(
  log: string,
  status: InstanceStatus,
  mode: DeploymentMode,
  startedAt?: string,
  health?: ClusterHealth,
): Progress {
  const op = lastOperation(stripAnsi(log));
  // A destroying/destroyed status is authoritative even before the marker lands.
  const kind: OperationKind =
    status === "destroying" || status === "destroyed" ? "destroy" : op.kind;
  const failed = status === "failed";
  const settling = status === "bootstrapping";

  const core =
    kind === "destroy"
      ? destroyProgress(op.text, status, failed)
      : applyProgress(op.text, status, mode, failed, health);

  // Freeze the timer once the run has finished so it reports duration, not age.
  // While the cluster is still forming the work is ongoing, so the clock keeps running.
  const startedMs = new Date(op.startedAt ?? startedAt ?? "").getTime();
  const endedMs = op.finishedAt && !settling ? new Date(op.finishedAt).getTime() : Date.now();
  const elapsedSeconds = Number.isNaN(startedMs)
    ? undefined
    : Math.max(0, Math.round((endedMs - startedMs) / 1000));

  const complete = core.percent >= 100;
  const sections = collectSections(op.text, failed).map((s) =>
    complete ? { ...s, state: "done" as StepState, current: undefined } : s,
  );

  // The software install is invisible to Terraform, so it is reported from live probes.
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
