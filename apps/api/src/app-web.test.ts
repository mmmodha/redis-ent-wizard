import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appVmNetworkTags,
  describeAppWebExposure,
  normalizeAppMachineTypes,
  summarizeAppMachineTypes,
  normalizeAppDiskGib,
  parseAppExtraPorts,
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
      describeAppWebExposure({ exposeHttp: true, exposeHttps: true, extraPorts: [8080, 9090] }),
      "HTTP :80 + HTTPS :443 + TCP 8080, 9090 open from the internet",
    );
  });
});

describe("normalizeAppDiskGib", () => {
  it("returns one disk size per App VM and treats missing as 0", () => {
    assert.deepEqual(normalizeAppDiskGib({ app: 0 }), []);
    assert.deepEqual(normalizeAppDiskGib({ app: 2 }), [0, 0]);
    assert.deepEqual(normalizeAppDiskGib({ app: 3, app_disk_gib: [200, 0] }), [200, 0, 0]);
  });

  it("clamps invalid sizes to 0", () => {
    assert.deepEqual(normalizeAppDiskGib({ app: 2, app_disk_gib: [-10, 99999] }), [0, 0]);
  });
});

describe("parseAppExtraPorts", () => {
  it("parses comma/space lists and ranges, skips SSH, de-dupes", () => {
    assert.deepEqual(parseAppExtraPorts(""), []);
    assert.deepEqual(parseAppExtraPorts("8080, 9090,22,8080"), [8080, 9090]);
    assert.deepEqual(parseAppExtraPorts("3000-3002 6379"), [3000, 3001, 3002, 6379]);
    assert.deepEqual(parseAppExtraPorts([80, 443, 22]), []);
  });

  it("rejects out-of-range and non-numeric tokens", () => {
    assert.throws(() => parseAppExtraPorts("0"), /1–65535|1-65535/);
    assert.throws(() => parseAppExtraPorts("abc"), /port/);
    assert.throws(() => parseAppExtraPorts("8000-7999"), /range/);
  });
});

describe("appVmNetworkTags extra ports", () => {
  it("adds app-extra when custom ports are requested", () => {
    assert.ok(
      !appVmNetworkTags({
        exposeHttp: false,
        exposeHttps: false,
        memvizEnabled: false,
      }).includes("app-extra"),
    );
    assert.deepEqual(
      appVmNetworkTags({
        exposeHttp: false,
        exposeHttps: false,
        memvizEnabled: false,
        extraPorts: [8080],
      }),
      ["ssh", "app-extra"],
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
