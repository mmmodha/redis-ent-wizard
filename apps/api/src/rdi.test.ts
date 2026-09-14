import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeRdi,
  normalizeRdiName,
  rdiFullName,
  rdiSourceNames,
  rdiStateDbName,
  withRdiInternalDatabases,
} from "./rdi.js";
import type { CreateInstanceInput } from "./types.js";

describe("normalizeRdiName", () => {
  it("slugifies and validates", () => {
    assert.equal(normalizeRdiName("My RDI"), "my-rdi");
    assert.throws(() => normalizeRdiName(""), /required/);
    assert.throws(() => normalizeRdiName("1x"), /start with a letter/);
  });
});

describe("normalizeRdi", () => {
  it("returns null with no rdi", () => {
    assert.equal(normalizeRdi({}), null);
  });

  it("defaults machine type and dedupes pipeline sources", () => {
    const out = normalizeRdi({
      rdi: { name: "ingest", target: "cache", pipelines: [{ source: "orders" }] },
    })!;
    assert.equal(out.name, "ingest");
    assert.equal(out.machine_type, "n2-standard-4");
    assert.equal(out.target, "cache");
    assert.equal(out.pipelines[0].source, "orders");
    assert.throws(
      () => normalizeRdi({ rdi: { name: "x", pipelines: [{ source: "a" }, { source: "a" }] } }),
      /unique/,
    );
  });
});

describe("rdiFullName / rdiStateDbName", () => {
  it("prefixes the runtime name and names the state DB", () => {
    assert.equal(rdiFullName("demo-default", "ingest"), "demo-default-ingest");
    assert.equal(rdiStateDbName("ingest"), "ingest-state");
  });
});

describe("rdiSourceNames", () => {
  it("collects pipeline sources", () => {
    const set = rdiSourceNames({ rdi: { name: "x", pipelines: [{ source: "orders" }, { source: "events" }] } });
    assert.deepEqual([...set].sort(), ["events", "orders"]);
  });
});

describe("withRdiInternalDatabases", () => {
  const base = (): CreateInstanceInput =>
    ({
      name: "demo",
      mode: "vm",
      clusters: [{ name: "cache", nodes: 3, databases: [{ name: "target", memory_gb: 1, port: 12000 }] }],
      cloud_sql_instances: [{ name: "orders" }],
      rdi: { name: "ingest", target: "target", pipelines: [{ source: "orders" }] },
    }) as unknown as CreateInstanceInput;

  it("synthesizes a state DB in the target's cluster", () => {
    const out = withRdiInternalDatabases(base());
    const dbs = out.clusters![0].databases!;
    const state = dbs.find((d) => d.rdi_internal);
    assert.ok(state, "state DB synthesized");
    assert.equal(state!.name, "ingest-state");
    assert.ok(state!.password && state!.password.length > 0, "state DB has a generated password");
    assert.equal(dbs.filter((d) => d.rdi_internal).length, 1);
  });

  it("is idempotent — re-running does not duplicate the state DB", () => {
    const once = withRdiInternalDatabases(base());
    const twice = withRdiInternalDatabases(once);
    assert.equal(twice.clusters![0].databases!.filter((d) => d.rdi_internal).length, 1);
  });

  it("adds nothing when there is no target", () => {
    const input = { ...base(), rdi: { name: "ingest", pipelines: [{ source: "orders" }] } } as CreateInstanceInput;
    const out = withRdiInternalDatabases(input);
    assert.equal(out.clusters![0].databases!.filter((d) => d.rdi_internal).length, 0);
  });
});
