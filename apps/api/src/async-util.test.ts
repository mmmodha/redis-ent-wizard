import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapWithConcurrency, withRetry } from "./async-util.js";

describe("mapWithConcurrency", () => {
  it("preserves order and never exceeds the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`);
  });

  it("handles an empty input", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("retries a retryable error then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { shouldRetry: () => true, sleep: noSleep },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("does not retry when shouldRetry is false", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        { shouldRetry: () => false, sleep: noSleep },
      ),
      /fatal/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("always");
        },
        { attempts: 3, shouldRetry: () => true, sleep: noSleep },
      ),
      /always/,
    );
    assert.equal(calls, 3);
  });
});
