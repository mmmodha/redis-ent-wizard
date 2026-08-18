import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appVmNetworkTags,
  describeAppWebExposure,
  normalizeAppMachineTypes,
  summarizeAppMachineTypes,
} from "./app-web.js";

describe("appVmNetworkTags", () => {
  it("always includes ssh and never the Redis http tag", () => {
    const tags = appVmNetworkTags({
      exposeHttp: false,
      exposeHttps: false,
      memvizEnabled: false,
    });
    assert.deepEqual(tags, ["ssh"]);
    assert.ok(!tags.includes("http"));
  });

  it("adds app-http and app-https only when toggled", () => {
    assert.deepEqual(
      appVmNetworkTags({ exposeHttp: true, exposeHttps: false, memvizEnabled: false }),
      ["ssh", "app-http"],
    );
    assert.deepEqual(
      appVmNetworkTags({ exposeHttp: false, exposeHttps: true, memvizEnabled: false }),
      ["ssh", "app-https"],
    );
    assert.deepEqual(
      appVmNetworkTags({ exposeHttp: true, exposeHttps: true, memvizEnabled: true }),
      ["ssh", "app-http", "app-https", "memviz"],
    );
  });
});

describe("describeAppWebExposure", () => {
  it("summarizes closed and open public ports", () => {
    assert.equal(
      describeAppWebExposure({ exposeHttp: false, exposeHttps: false, memvizEnabled: false }),
      "no public HTTP/HTTPS (SSH only)",
    );
    assert.equal(
      describeAppWebExposure({ exposeHttp: true, exposeHttps: false, memvizEnabled: false }),
      "HTTP :80 open from the internet",
    );
    assert.equal(
      describeAppWebExposure({ exposeHttp: false, exposeHttps: true, memvizEnabled: false }),
      "HTTPS :443 open from the internet",
    );
    assert.equal(
      describeAppWebExposure({ exposeHttp: true, exposeHttps: true, memvizEnabled: true }),
      "HTTP :80 + HTTPS :443 open from the internet",
    );
  });
});

describe("normalizeAppMachineTypes", () => {
  it("returns one type per App VM and pads missing slots", () => {
    assert.deepEqual(normalizeAppMachineTypes({ app: 0 }), []);
    assert.deepEqual(
      normalizeAppMachineTypes({ app: 3, app_machine_types: ["n2-standard-8", "e2-standard-2"] }),
      ["n2-standard-8", "e2-standard-2", "n2-standard-8"],
    );
    assert.deepEqual(
      normalizeAppMachineTypes({ app: 2, app_machine_type: "e2-standard-4" }),
      ["e2-standard-4", "e2-standard-4"],
    );
  });

  it("keeps list index positions and fills blanks from the legacy type", () => {
    assert.deepEqual(
      normalizeAppMachineTypes({
        app: 2,
        app_machine_types: [" n2-standard-16 ", ""],
        app_machine_type: "e2-standard-2",
      }),
      ["n2-standard-16", "e2-standard-2"],
    );
  });
});

describe("summarizeAppMachineTypes", () => {
  it("collapses identical types and lists mixed sizes", () => {
    assert.equal(summarizeAppMachineTypes([]), "None");
    assert.equal(summarizeAppMachineTypes(["e2-standard-2", "e2-standard-2"]), "2 × e2-standard-2");
    assert.equal(
      summarizeAppMachineTypes(["n2-standard-8", "e2-standard-2"]),
      "n2-standard-8, e2-standard-2",
    );
  });
});
