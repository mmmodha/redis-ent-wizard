import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeApplicationName, normalizeApplications } from "./applications.js";
import type { Application } from "./types.js";

describe("normalizeApplicationName", () => {
  it("slugs and lowercases", () => {
    assert.equal(normalizeApplicationName("My App 1"), "my-app-1");
  });
  it("rejects empty and reserved names", () => {
    assert.throws(() => normalizeApplicationName(""));
    assert.throws(() => normalizeApplicationName("app"));
    assert.throws(() => normalizeApplicationName("123"));
  });
});

describe("normalizeApplications (vm)", () => {
  const vmApp = (over: Partial<Application> = {}): Application => ({
    name: "loader",
    artifact: { kind: "url", ref: "https://example.com/app.jar", type: "jar" },
    command: "java -jar app.jar",
    vm_count: 2,
    ...over,
  });

  it("keeps a valid vm application and clamps counts", () => {
    const [app] = normalizeApplications({ mode: "vm", applications: [vmApp({ vm_count: 99 })] });
    assert.equal(app.name, "loader");
    assert.equal(app.vm_count, 10);
    assert.equal(app.artifact?.kind, "url");
  });

  it("allows an empty command (stage only)", () => {
    const [app] = normalizeApplications({ mode: "vm", applications: [vmApp({ command: "" })] });
    assert.equal(app.command, "");
  });

  it("requires an artifact in vm mode", () => {
    assert.throws(() => normalizeApplications({ mode: "vm", applications: [{ name: "x" }] }));
  });

  it("rejects a non-http url artifact and a bad gcs uri", () => {
    assert.throws(() =>
      normalizeApplications({ mode: "vm", applications: [vmApp({ artifact: { kind: "url", ref: "ftp://x", type: "binary" } })] }),
    );
    assert.throws(() =>
      normalizeApplications({ mode: "vm", applications: [vmApp({ artifact: { kind: "gcs", ref: "http://x", type: "binary" } })] }),
    );
  });

  it("rejects duplicate names", () => {
    assert.throws(() =>
      normalizeApplications({ mode: "vm", applications: [vmApp(), vmApp()] }),
    );
  });
});

describe("normalizeApplications (gke)", () => {
  it("requires an image and clamps replicas", () => {
    const [app] = normalizeApplications({
      mode: "gke",
      applications: [{ name: "svc", image: "nginx:latest", replicas: 999, expose: "lb" }],
    });
    assert.equal(app.image, "nginx:latest");
    assert.equal(app.replicas, 20);
    assert.equal(app.expose, "lb");
    assert.throws(() => normalizeApplications({ mode: "gke", applications: [{ name: "svc" }] }));
  });
});
