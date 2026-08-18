import fs from "node:fs";
import path from "node:path";
import {
  dbGetInstance,
  dbReadInstances,
  dbRemoveInstance,
  dbUpsertInstance,
} from "./db.js";
import type { InstanceRecord } from "./types.js";

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");

export function getDataDir(): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export async function readRegistry(): Promise<InstanceRecord[]> {
  return dbReadInstances();
}

export async function getInstance(id: string): Promise<InstanceRecord | undefined> {
  return dbGetInstance(id);
}

export async function upsertInstance(record: InstanceRecord): Promise<InstanceRecord> {
  return dbUpsertInstance(record);
}

export async function removeInstance(id: string): Promise<void> {
  await dbRemoveInstance(id);
}

export function instanceDir(id: string): string {
  const dir = path.join(getDataDir(), "instances", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendLog(id: string, line: string): void {
  const logFile = path.join(instanceDir(id), "apply.log");
  fs.appendFileSync(logFile, line.endsWith("\n") ? line : line + "\n", "utf8");
}

export function readLog(id: string): string {
  const logFile = path.join(instanceDir(id), "apply.log");
  if (!fs.existsSync(logFile)) return "";
  return fs.readFileSync(logFile, "utf8");
}

export function writeOutputs(id: string, outputs: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(instanceDir(id), "outputs.json"),
    JSON.stringify(outputs, null, 2) + "\n",
    "utf8",
  );
}

export function readOutputs(id: string): Record<string, unknown> {
  const file = path.join(instanceDir(id), "outputs.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
