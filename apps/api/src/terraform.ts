import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  appendLog,
  getInstance,
  instanceDir,
  readOutputs,
  upsertInstance,
  writeOutputs,
  removeInstance,
} from "./registry.js";
import { probeHealth } from "./health.js";
import { acquireJobSlot, isJobActive, releaseJobSlot } from "./jobs.js";
import type { InstanceRecord } from "./types.js";

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

        const nextStatus = health.state === "ready" ? "ready" : "bootstrapping";
        await upsertInstance({
          ...current,
          status: nextStatus,
          health,
          updatedAt: new Date().toISOString(),
        });

        if (health.state === "ready") {
          appendLog(id, `\n=== CLUSTER READY ${new Date().toISOString()} — ${health.detail} ===\n`);
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
      record.status = "bootstrapping";
      record.updatedAt = new Date().toISOString();
      await upsertInstance(record);
      appendLog(id, `\n=== APPLY COMPLETE ${new Date().toISOString()} ===\n`);
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

export async function getMergedOutputs(id: string): Promise<Record<string, unknown>> {
  const record = await getInstance(id);
  const fileOutputs = readOutputs(id);
  return { ...(record?.endpoints || {}), ...fileOutputs };
}
