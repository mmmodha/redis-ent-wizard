import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RS_VERSION,
  GKE_OPERATOR_RELEASES,
  VM_RS_RELEASES,
  resolveGkeOperatorChart,
  resolveVmRelease,
  rsVersionFromUrl,
} from "./rs-releases.js";

describe("resolveVmRelease", () => {
  it("resolves the default 8.2.0-46 jammy tarball", () => {
    const rel = resolveVmRelease();
    assert.equal(rel.id, DEFAULT_RS_VERSION);
    assert.equal(rel.id, "8.2.0-46");
    assert.equal(
      rel.url,
      "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar",
    );
  });

  it("resolves known version ids and passes through a custom URL", () => {
    const v722 = resolveVmRelease("7.22.0-28");
    assert.match(v722.url, /7\.22\.0-28-jammy-amd64\.tar$/);
    const custom = resolveVmRelease(
      "https://example.com/redislabs-9.0.0-1-jammy-amd64.tar",
    );
    assert.equal(custom.url, "https://example.com/redislabs-9.0.0-1-jammy-amd64.tar");
    assert.equal(custom.id, "9.0.0-1");
  });

  it("rejects unknown version ids", () => {
    assert.throws(() => resolveVmRelease("0.0.0-0"), /unknown|not supported/i);
  });

  it("lists curated VM releases including 7.22, 8.0 and 8.2", () => {
    const ids = VM_RS_RELEASES.map((r) => r.id);
    assert.ok(ids.includes("8.2.0-46"));
    assert.ok(ids.some((id) => id.startsWith("8.0.")));
    assert.ok(ids.some((id) => id.startsWith("7.22.")));
  });
});

describe("rsVersionFromUrl", () => {
  it("extracts the build from a jammy tarball URL", () => {
    assert.equal(
      rsVersionFromUrl(
        "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar",
      ),
      "8.2.0-46",
    );
  });
});

describe("resolveGkeOperatorChart", () => {
  it("treats empty as latest", () => {
    assert.equal(resolveGkeOperatorChart(), "");
    assert.equal(resolveGkeOperatorChart("latest"), "");
  });

  it("accepts pinned chart versions from the catalog", () => {
    assert.ok(GKE_OPERATOR_RELEASES.length >= 2);
    const pinned = GKE_OPERATOR_RELEASES.find((r) => r.id !== "latest");
    assert.ok(pinned);
    assert.equal(resolveGkeOperatorChart(pinned!.id), pinned!.chartVersion);
  });
});
