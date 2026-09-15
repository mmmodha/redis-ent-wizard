import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createSchema, designSchema } from "./schema.js";
import { renderTerraform } from "./workspace.js";
import type { CreateInstanceInput } from "./types.js";

describe("createSchema (define validation)", () => {
  it("rejects a malformed config", () => {
    const r = createSchema.safeParse({ name: "X", mode: "vm" });
    assert.equal(r.success, false);
  });

  it("accepts a minimal valid VM config", () => {
    const r = createSchema.safeParse({
      name: "demo",
      mode: "vm",
      youremail: "jane_doe",
      project: "proj",
      credentialsFile: "key.json",
    });
    assert.equal(r.success, true);
  });
});

describe("designSchema (define surface)", () => {
  it("accepts a config without project/credentialsFile (human/model fills later)", () => {
    const r = designSchema.safeParse({ name: "demo", mode: "vm", youremail: "jane_doe" });
    assert.equal(r.success, true);
  });

  it("accepts blank project/credentialsFile (web sends '' for an unset picker)", () => {
    const r = designSchema.safeParse({
      name: "demo",
      mode: "vm",
      youremail: "jane_doe",
      project: "",
      credentialsFile: "",
      region_name: "",
    });
    assert.equal(r.success, true);
  });

  it("still requires name/mode/youremail", () => {
    assert.equal(designSchema.safeParse({ name: "demo", mode: "vm" }).success, false);
  });
});

describe("renderTerraform (define render, no apply)", () => {
  const input = {
    name: "demo",
    mode: "vm",
    youremail: "jane_doe",
    project: "proj",
    credentialsFile: "key.json",
    region_name: "europe-west1",
    clusters: [{ name: "cache", nodes: 3, databases: [{ name: "sessions", memory_gb: 1, port: 12000 }] }],
  } as unknown as CreateInstanceInput;

  it("returns Terraform text for a VM config without applying", () => {
    const { tfvars, mainTf, variablesTf } = renderTerraform("vm", input);
    assert.match(tfvars, /clustersize = 3/);
    assert.match(tfvars, /machine_type/);
    assert.match(mainTf, /module "stack"/);
    assert.match(variablesTf, /variable "clusters"/);
    // Placeholder credentials/ssh — never a real key path.
    assert.doesNotMatch(tfvars, /BEGIN|PRIVATE KEY/);
  });

  it("renders a per-cluster RS_admin in tfvars and the clusters variable type", () => {
    const twoClusters = {
      name: "demo",
      mode: "vm",
      youremail: "jane_doe",
      project: "proj",
      credentialsFile: "key.json",
      clusters: [
        { name: "primary", nodes: 3, RS_admin: "primary_admin@redis.io" },
        { name: "cache", nodes: 3, RS_admin: "cache_admin@redis.io" },
      ],
    } as unknown as CreateInstanceInput;
    const { tfvars, variablesTf } = renderTerraform("vm", twoClusters);
    assert.match(variablesTf, /RS_admin\s*=\s*optional\(string/);
    assert.match(tfvars, /primary_admin@redis\.io/);
    assert.match(tfvars, /cache_admin@redis\.io/);
  });
});

describe("create-config JSON Schema (MCP tool input)", () => {
  it("derives an object schema exposing the core fields", () => {
    const js = zodToJsonSchema(createSchema, { name: "CreateInstanceInput", $refStrategy: "none" }) as {
      definitions: { CreateInstanceInput: { type: string; properties: Record<string, unknown> } };
    };
    const def = js.definitions.CreateInstanceInput;
    assert.equal(def.type, "object");
    for (const field of ["name", "mode", "youremail", "project", "clusters", "rdi"]) {
      assert.ok(field in def.properties, `expected JSON schema to expose ${field}`);
    }
  });
});
