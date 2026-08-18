/**
 * In-process job queue with global and per-user concurrency caps.
 * Apply/destroy work is still executed by terraform.ts; this module gates starts.
 */

export type JobKind = "apply" | "destroy";

type Slot = { id: string; kind: JobKind; ownerSub: string; startedAt: number };

const running = new Map<string, Slot>();
const waiters: Array<{
  id: string;
  kind: JobKind;
  ownerSub: string;
  resolve: () => void;
  reject: (err: Error) => void;
}> = [];

function globalLimit(): number {
  return Number(process.env.JOB_GLOBAL_LIMIT || 10);
}

function perUserLimit(): number {
  return Number(process.env.JOB_PER_USER_LIMIT || 2);
}

function tryDispatch(): void {
  while (waiters.length && running.size < globalLimit()) {
    const next = waiters[0];
    const userRunning = [...running.values()].filter((s) => s.ownerSub === next.ownerSub).length;
    if (userRunning >= perUserLimit()) {
      // Skip this user for now; try later when a slot frees.
      const blocked = waiters.filter((w) => w.ownerSub === next.ownerSub);
      const others = waiters.filter((w) => w.ownerSub !== next.ownerSub);
      if (!others.length) return;
      waiters.length = 0;
      waiters.push(...others, ...blocked);
      continue;
    }
    waiters.shift();
    running.set(next.id, {
      id: next.id,
      kind: next.kind,
      ownerSub: next.ownerSub,
      startedAt: Date.now(),
    });
    next.resolve();
  }
}

export function queueStats() {
  return {
    running: running.size,
    waiting: waiters.length,
    globalLimit: globalLimit(),
    perUserLimit: perUserLimit(),
    jobs: [...running.values()],
  };
}

export function isJobActive(id: string): boolean {
  return running.has(id) || waiters.some((w) => w.id === id);
}

/** Acquire a concurrency slot before starting terraform work. */
export function acquireJobSlot(id: string, kind: JobKind, ownerSub: string): Promise<void> {
  if (running.has(id)) return Promise.resolve();
  const userRunning = [...running.values()].filter((s) => s.ownerSub === ownerSub).length;
  if (running.size < globalLimit() && userRunning < perUserLimit()) {
    running.set(id, { id, kind, ownerSub, startedAt: Date.now() });
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    waiters.push({ id, kind, ownerSub, resolve, reject });
  });
}

export function releaseJobSlot(id: string): void {
  running.delete(id);
  // Cancel any waiter for the same id (e.g. destroyed while queued)
  const idx = waiters.findIndex((w) => w.id === id);
  if (idx >= 0) {
    const [w] = waiters.splice(idx, 1);
    w.reject(new Error("Job cancelled"));
  }
  tryDispatch();
}
