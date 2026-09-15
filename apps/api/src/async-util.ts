/** Small concurrency + retry helpers, used to fan out GCP list calls safely. */

/**
 * Map `items` through `fn` with at most `limit` in flight at once, preserving
 * input order in the result. Rejections propagate (first rejection wins).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RetryOptions {
  /** Max attempts including the first. Default 4. */
  attempts?: number;
  /** Base backoff in ms (doubled each retry). Default 300. */
  baseDelayMs?: number;
  /** Whether an error is retryable. Default: never. */
  shouldRetry?: (err: unknown) => boolean;
  /** Sleep function (injectable for tests). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying with exponential backoff while `shouldRetry` holds. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 300;
  const shouldRetry = opts.shouldRetry ?? (() => false);
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
