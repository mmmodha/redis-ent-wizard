import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeCloudSql,
  normalizeSqlName,
  sqlDatabaseVersion,
  sqlInstanceFullName,
  sqlPort,
} from "./cloudsql.js";

describe("normalizeSqlName", () => {
  it("slugifies and validates", () => {
    assert.equal(normalizeSqlName("My Orders"), "my-orders");
    assert.throws(() => normalizeSqlName(""), /required/);
    assert.throws(() => normalizeSqlName("1db"), /start with a letter/);
  });
});

describe("sqlInstanceFullName", () => {
  it("prefixes with the deployment name", () => {
    assert.equal(sqlInstanceFullName("demo-default", "orders"), "demo-default-orders");
  });
});

describe("sqlDatabaseVersion / sqlPort", () => {
  it("maps engine to version and port", () => {
    assert.equal(sqlDatabaseVersion("postgres"), "POSTGRES_15");
    assert.equal(sqlDatabaseVersion("mysql"), "MYSQL_8_0");
    assert.equal(sqlPort("postgres"), 5432);
    assert.equal(sqlPort("mysql"), 3306);
  });
});

describe("normalizeCloudSql", () => {
  it("applies defaults and rejects duplicates", () => {
    const out = normalizeCloudSql({
      cloud_sql_instances: [{ name: "Orders" }, { name: "events", engine: "mysql", connectivity: "proxy" }],
    });
    assert.deepEqual(out[0], {
      name: "orders",
      engine: "postgres",
      tier: "db-f1-micro",
      db_name: "appdb",
      db_user: "appuser",
      connectivity: "private",
    });
    assert.equal(out[1].engine, "mysql");
    assert.equal(out[1].connectivity, "proxy");
    assert.throws(
      () => normalizeCloudSql({ cloud_sql_instances: [{ name: "d" }, { name: "d" }] }),
      /unique/,
    );
  });

  it("falls back to private for an unknown connectivity", () => {
    const out = normalizeCloudSql({
      cloud_sql_instances: [{ name: "orders", connectivity: "bogus" as never }],
    });
    assert.equal(out[0].connectivity, "private");
  });
});
