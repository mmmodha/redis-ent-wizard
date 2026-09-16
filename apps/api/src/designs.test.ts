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

  it("renders GKE operators, each with its version + namespace and its RECs", () => {
    const gke = {
      name: "demo",
      mode: "gke",
      youremail: "jane_doe",
      project: "proj",
      credentialsFile: "key.json",
      region_name: "europe-west1",
      operators: [
        { name: "operator", operator_chart_version: "latest" },
        { name: "search-ops", operator_chart_version: "7.22.2-16" },
      ],
      clusters: [
        { name: "cache", rec_nodes: 3, operator: "operator" },
        { name: "search", rec_nodes: 5, operator: "search-ops" },
      ],
    } as unknown as CreateInstanceInput;
    const { tfvars, variablesTf } = renderTerraform("gke", gke);
    // The operators variable replaces the old flat rec_specs/operator_chart_version.
    assert.match(variablesTf, /variable "operators"/);
    assert.doesNotMatch(variablesTf, /variable "rec_specs"/);
    // Each operator lands with its resolved chart version and namespace.
    assert.match(tfvars, /chart_version\s*=\s*"7\.22\.2-16"/);
    assert.match(tfvars, /namespace\s*=\s*"rec-ns"/); // default operator
    assert.match(tfvars, /namespace\s*=\s*"rec-ns-search-ops"/);
    // Each cluster becomes a REC grouped under its operator.
    assert.match(tfvars, /demo-default-cache-rec/);
    assert.match(tfvars, /demo-default-search-rec/);
  });

  it("synthesizes a single default operator for a pre-operator GKE config", () => {
    const legacy = {
      name: "demo",
      mode: "gke",
      youremail: "jane_doe",
      project: "proj",
      credentialsFile: "key.json",
      operator_chart_version: "7.8.6-2",
      clusters: [{ name: "cache", rec_nodes: 3 }],
    } as unknown as CreateInstanceInput;
    const { tfvars } = renderTerraform("gke", legacy);
    assert.match(tfvars, /name\s*=\s*"operator"/);
    assert.match(tfvars, /namespace\s*=\s*"rec-ns"/);
    assert.match(tfvars, /chart_version\s*=\s*"7\.8\.6-2"/);
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
