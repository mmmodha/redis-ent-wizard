import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grantsPublisher, grantsSubscriber, normalizePubsub, normalizeTopicName, topicFullName } from "./pubsub.js";

describe("normalizeTopicName", () => {
  it("slugifies and validates", () => {
    assert.equal(normalizeTopicName("My Events"), "my-events");
    assert.throws(() => normalizeTopicName(""), /required/);
    assert.throws(() => normalizeTopicName("1topic"), /start with a letter/);
  });
});

describe("topicFullName", () => {
  it("prefixes with the deployment prefix", () => {
    assert.equal(topicFullName("demo-default", "events"), "demo-default-events");
  });
});

describe("normalizePubsub", () => {
  it("applies defaults and rejects duplicates", () => {
    const out = normalizePubsub({
      pubsub_topics: [{ name: "Events" }, { name: "jobs", create_subscription: true, role: "publish" }],
    });
    assert.deepEqual(out[0], { name: "events", create_subscription: false, role: "both" });
    assert.equal(out[1].create_subscription, true);
    assert.equal(out[1].role, "publish");
    assert.throws(() => normalizePubsub({ pubsub_topics: [{ name: "d" }, { name: "d" }] }), /unique/);
  });
});

describe("grant helpers", () => {
  it("map role to publisher/subscriber", () => {
    assert.equal(grantsPublisher("both"), true);
    assert.equal(grantsPublisher("subscribe"), false);
    assert.equal(grantsSubscriber("both"), true);
    assert.equal(grantsSubscriber("publish"), false);
  });
});
