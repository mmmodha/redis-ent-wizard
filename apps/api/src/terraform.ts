import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  appendLog,
  getInstance,
  instanceDir,
  readLog,
  readOutputs,
  upsertInstance,
  writeOutputs,
  removeInstance,
} from "./registry.js";
import { probeHealth } from "./health.js";
import { applyLicenses, createDatabases, hasDatabases, hasLicenses } from "./databases.js";
import { acquireJobSlot, isJobActive, releaseJobSlot } from "./jobs.js";
import { normalizeClusters } from "./clusters.js";
import { appWorkloadsSucceeded, progressExtrasFromConfig } from "./progress.js";
import type { CreateInstanceInput, InstanceRecord } from "./types.js";

const jobs = new Map<string, { kind: "apply" | "destroy" }>();

/** Terraform returning success only means the VMs exist; Redis Enterprise installs
 * afterwards from the startup script. These bound the wait for it to come up. */
const BOOTSTRAP_TIMEOUT_MS = 25 * 60 * 1000;
const BOOTSTRAP_INTERVAL_MS = 15 * 1000;

const watchers = new Set<string>();

export function isWatching(id: string): boolean {
  return watchers.has(id);
}

export function watchBootstrap(id: string): void {
  if (watchers.has(id)) return;
  watchers.add(id);

  void (async () => {
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const record = await getInstance(id);
        if (!record || record.status === "destroying" || record.status === "destroyed") return;
        if (record.status === "applying" || record.status === "failed") return;

        const health = await probeHealth(record);
        const current = await getInstance(id);
        if (!current) return;

        const alreadyReady = current.status === "ready";
        await upsertInstance({
          ...current,
          status: alreadyReady ? "ready" : "bootstrapping",
          health,
          updatedAt: new Date().toISOString(),
        });

        if (health.state === "ready") {
          if (!alreadyReady) {
            appendLog(id, `\n=== CLUSTER READY ${new Date().toISOString()} — ${health.detail} ===\n`);
            await provisionClusterResources(id);
            appendLog(id, `\n=== CLUSTER RESOURCES COMPLETE ${new Date().toISOString()} ===\n`);
            const latest = await getInstance(id);
            if (latest && latest.status !== "destroying" && latest.status !== "destroyed" && latest.status !== "failed") {
              await upsertInstance({ ...latest, status: "ready", updatedAt: new Date().toISOString() });
            }
          }
          return;
        }

        await new Promise((r) => setTimeout(r, BOOTSTRAP_INTERVAL_MS));
      }

      const timedOut = await getInstance(id);
      if (timedOut && timedOut.status === "bootstrapping") {
        const health = timedOut.health;
        const detail = health
          ? `${health.nodesActive} of ${health.nodesExpected} nodes active after 25 minutes`
          : "Cluster did not become ready within 25 minutes";
        appendLog(id, `\nWARNING: ${detail}\n`);
        await upsertInstance({
          ...timedOut,
          status: "degraded",
          lastError: detail,
          updatedAt: new Date().toISOString(),
        });
      }
    } finally {
      watchers.delete(id);
    }
  })();
}

/**
 * Remove a stale local-backend state lock left by a job that was killed
 * (e.g. the container was restarted mid-apply/destroy). Safe in this
 * single-container deployment: the per-id job guard means no other worker is
 * touching this workspace when a job starts, so any lock present is orphaned.
 * Only the state lock is removed — never the provider lock (.terraform.lock.hcl).
 */
function clearStaleStateLock(id: string, workDir: string): void {
  const lock = path.join(workDir, ".terraform.tfstate.lock.info");
  if (fs.existsSync(lock)) {
    fs.rmSync(lock, { force: true });
    appendLog(id, "Cleared a stale Terraform state lock from an interrupted run.\n");
  }
}

function runCommand(
  id: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    appendLog(id, `$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TF_IN_AUTOMATION: "1",
        TF_INPUT: "0",
      },
    });

    child.stdout.on("data", (buf: Buffer) => appendLog(id, buf.toString("utf8")));
    child.stderr.on("data", (buf: Buffer) => appendLog(id, buf.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function collectOutputs(id: string, workDir: string, record: InstanceRecord): Promise<void> {
  const outFile = path.join(workDir, "tf-output.json");
  const code = await runCommand(id, "terraform", ["output", "-json"], workDir);
  if (code !== 0) return;

  const captured = await new Promise<string>((resolve, reject) => {
    const child = spawn("terraform", ["output", "-json"], { cwd: workDir });
    let data = "";
    child.stdout.on("data", (b: Buffer) => {
      data += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => appendLog(id, b.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve(data));
  });

  let parsed: Record<string, { value: unknown }> = {};
  try {
    parsed = JSON.parse(captured) as Record<string, { value: unknown }>;
  } catch {
    appendLog(id, "Failed to parse terraform output JSON\n");
    return;
  }

  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    flat[k] = v.value;
  }

  const k8sFile = path.join(workDir, "k8s-outputs.json");
  if (fs.existsSync(k8sFile)) {
    try {
      const k8s = JSON.parse(fs.readFileSync(k8sFile, "utf8")) as Record<string, unknown>;
      Object.assign(flat, k8s);
    } catch {
      appendLog(id, "Failed to parse k8s-outputs.json\n");
    }
  }

  // GKE application Deployments/Services (namespaced so it never collides with
  // the VM `apps` output, which lists companion app VMs).
  const appFile = path.join(workDir, "app-outputs.json");
  if (fs.existsSync(appFile)) {
    try {
      const appOut = JSON.parse(fs.readFileSync(appFile, "utf8")) as { apps?: unknown };
      if (Array.isArray(appOut.apps)) flat.gke_app_services = appOut.apps;
    } catch {
      appendLog(id, "Failed to parse app-outputs.json\n");
    }
  }

  writeOutputs(id, flat);
  fs.writeFileSync(outFile, JSON.stringify(flat, null, 2) + "\n", "utf8");

  record.endpoints = flat;
  record.updatedAt = new Date().toISOString();
  await upsertInstance(record);
}

export function isBusy(id: string): boolean {
  return jobs.has(id) || isJobActive(id);
}

export async function startApply(id: string, ownerSub = "system"): Promise<void> {
  if (jobs.has(id)) throw new Error("Job already running for this instance");
  jobs.set(id, { kind: "apply" });

  const workDir = instanceDir(id);
  void (async () => {
    try {
      appendLog(id, `Queued apply (waiting for a worker slot)…\n`);
      await acquireJobSlot(id, "apply", ownerSub);

      let record = await getInstance(id);
      if (!record) return;

      const startedAt = new Date().toISOString();
      record = {
        ...record,
        status: "applying",
        updatedAt: startedAt,
        lastApplyStartedAt: startedAt,
        lastError: undefined,
      };
      await upsertInstance(record);
      appendLog(id, `\n=== APPLY START ${new Date().toISOString()} ===\n`);
      clearStaleStateLock(id, workDir);

      let code = await runCommand(id, "terraform", ["init", "-input=false"], workDir);
      if (code !== 0) throw new Error(`terraform init failed with code ${code}`);

      code = await runCommand(
        id,
        "terraform",
        ["apply", "-auto-approve", "-input=false", "-var-file=terraform.tfvars"],
        workDir,
      );
      if (code !== 0) throw new Error(`terraform apply failed with code ${code}`);

      record = (await getInstance(id))!;
      await collectOutputs(id, workDir, record);
      record = (await getInstance(id))!;
      const redis = normalizeClusters({
        ...((record.config || {}) as unknown as CreateInstanceInput),
        mode: record.mode,
      }).length > 0;
      appendLog(id, `\n=== APPLY COMPLETE ${new Date().toISOString()} ===\n`);
      if (!redis) {
        const extras = progressExtrasFromConfig(
          (record.config || {}) as Record<string, unknown>,
          record.mode,
        );
        const names = (extras.appWorkloads || []).map((a) => a.name);
        if (!appWorkloadsSucceeded(readLog(id), names)) {
          throw new Error(
            "Terraform finished but the application did not finish setup on the VM. Check the log for APPWL clone/docker/start steps.",
          );
        }
        record.status = "ready";
        record.updatedAt = new Date().toISOString();
        await upsertInstance(record);
        appendLog(id, "Application VMs are provisioned. No Redis cluster to bootstrap.\n");
        return;
      }
      record.status = "bootstrapping";
      record.updatedAt = new Date().toISOString();
      await upsertInstance(record);
      appendLog(
        id,
        "Waiting for Redis Enterprise to install and the cluster to form before reporting ready.\n",
      );
      watchBootstrap(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog(id, `\nERROR: ${message}\n`);
      const current = await getInstance(id);
      if (current) {
        current.status = "failed";
        current.lastError = message;
        current.updatedAt = new Date().toISOString();
        await upsertInstance(current);
      }
    } finally {
      releaseJobSlot(id);
      jobs.delete(id);
    }
  })();
}

export async function startDestroy(
  id: string,
  removeAfter = true,
  ownerSub = "system",
): Promise<void> {
  if (jobs.has(id)) throw new Error("Job already running for this instance");
  jobs.set(id, { kind: "destroy" });

  const workDir = instanceDir(id);
  void (async () => {
    try {
      appendLog(id, `Queued destroy (waiting for a worker slot)…\n`);
      await acquireJobSlot(id, "destroy", ownerSub);

      let record = await getInstance(id);
      if (!record) return;

      const startedAt = new Date().toISOString();
      record = {
        ...record,
        status: "destroying",
        updatedAt: startedAt,
        lastDestroyStartedAt: startedAt,
        lastError: undefined,
      };
      await upsertInstance(record);
      appendLog(id, `\n=== DESTROY START ${startedAt} ===\n`);
      clearStaleStateLock(id, workDir);

      if (
        !fs.existsSync(path.join(workDir, ".terraform")) &&
        !fs.existsSync(path.join(workDir, "terraform.tfstate"))
      ) {
        appendLog(id, "No terraform state found; marking destroyed.\n");
      } else {
        if (!fs.existsSync(path.join(workDir, ".terraform"))) {
          await runCommand(id, "terraform", ["init", "-input=false"], workDir);
        }
        const code = await runCommand(
          id,
          "terraform",
          ["destroy", "-auto-approve", "-input=false", "-var-file=terraform.tfvars"],
          workDir,
        );
        if (code !== 0) throw new Error(`terraform destroy failed with code ${code}`);
      }

      appendLog(id, `\n=== DESTROY COMPLETE ${new Date().toISOString()} ===\n`);
      if (removeAfter) {
        await removeInstance(id);
      } else {
        const current = await getInstance(id);
        if (current) {
          current.status = "destroyed";
          current.updatedAt = new Date().toISOString();
          current.endpoints = {};
          await upsertInstance(current);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog(id, `\nERROR: ${message}\n`);
      const current = await getInstance(id);
      if (current) {
        current.status = "failed";
        current.lastError = message;
        current.updatedAt = new Date().toISOString();
        await upsertInstance(current);
      }
    } finally {
      releaseJobSlot(id);
      jobs.delete(id);
    }
  })();
}

/**
 * Post-bootstrap cluster setup via the RE REST API, once the cluster is ready:
 * apply per-cluster licenses first (a trial license caps shards/memory), then
 * create the configured databases. Idempotent — safe to call again (reconcile
 * / retry).
 */
export async function provisionClusterResources(id: string): Promise<void> {
  const record = await getInstance(id);
  if (!record || (!hasLicenses(record) && !hasDatabases(record))) return;

  if (hasLicenses(record)) {
    appendLog(id, `\n=== APPLYING LICENSES ${new Date().toISOString()} ===\n`);
    try {
      const licenseStates = await applyLicenses(record);
      const current = await getInstance(id);
      if (current) {
        await upsertInstance({ ...current, licenseStates, updatedAt: new Date().toISOString() });
      }
      for (const s of licenseStates) {
        appendLog(
          id,
          s.status === "applied"
            ? `  license applied to ${s.cluster}${s.detail ? ` (${s.detail})` : ""}\n`
            : `  license FAILED on ${s.cluster}: ${s.error || "unknown"}\n`,
        );
      }
    } catch (err) {
      appendLog(id, `  license application error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (!hasDatabases(record)) return;
  appendLog(id, `\n=== CREATING DATABASES ${new Date().toISOString()} ===\n`);
  try {
    const states = await createDatabases(record);
    const current = await getInstance(id);
    if (!current) return;
    await upsertInstance({ ...current, databaseStates: states, updatedAt: new Date().toISOString() });
    for (const s of states) {
      appendLog(
        id,
        s.status === "active"
          ? `  database ${s.cluster}/${s.name} ready${s.endpoint ? ` at ${s.endpoint}` : ""}\n`
          : `  database ${s.cluster}/${s.name} FAILED: ${s.error || "unknown"}\n`,
      );
    }
  } catch (err) {
    appendLog(id, `  database creation error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function getMergedOutputs(id: string): Promise<Record<string, unknown>> {
  const record = await getInstance(id);
  const fileOutputs = readOutputs(id);
  return { ...(record?.endpoints || {}), ...fileOutputs };
}
