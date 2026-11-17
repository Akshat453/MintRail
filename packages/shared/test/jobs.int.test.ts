/** Job queue + worker (ported from test_jobs_integration.py). */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { FrozenClock } from "../src/clock.js";
import * as jobs from "../src/jobs.js";
import { JobRegistry, PermanentJobError, Worker } from "../src/worker.js";
import { openDb, truncateAll } from "../../../tests/support/db.js";

let conn: ReturnType<typeof openDb>;
beforeAll(() => {
  conn = openDb();
});
afterAll(() => conn.close());
beforeEach(() => truncateAll(conn.db));
const db = () => conn.db;

const enqueueN = (n = 1, opts: jobs.EnqueueOptions = {}) =>
  db().transaction(async (tx) => {
    const ids: bigint[] = [];
    for (let i = 0; i < n; i++) ids.push((await jobs.enqueue(tx, "test.kind", { i: BigInt(i) }, opts))!);
    return ids;
  });
const job = async (id: bigint) => (await db().select().from(jobs.jobs).where(eq(jobs.jobs.id, id)))[0]!;
const claim = (workerId: string, limit = 10, queues = ["default"]) =>
  db().transaction((tx) => jobs.claim(tx, { queues, workerId, limit, visibilityTimeoutS: 60 }));

test("enqueue and claim", async () => {
  const [id] = await enqueueN();
  const claimed = await claim("w1");
  expect(claimed.map((c) => c.id)).toEqual([id]);
  expect(claimed[0]!.attempts).toBe(1);
  expect(claimed[0]!.payload).toEqual({ i: 0n });
  const row = await job(id!);
  expect([row.status, row.lockedBy]).toEqual(["running", "w1"]);
});

test("dedupe key", async () => {
  const [first, second] = await db().transaction(async (tx) => [
    await jobs.enqueue(tx, "k", {}, { dedupeKey: "evt_1" }),
    await jobs.enqueue(tx, "k", {}, { dedupeKey: "evt_1" }),
  ]);
  expect(first).not.toBeNull();
  expect(second).toBeNull();
});

test("future jobs are not claimed; queues are isolated", async () => {
  await enqueueN(1, { runAt: new Date(Date.now() + 3_600_000) });
  expect(await claim("w")).toEqual([]);
  await enqueueN(1, { queue: "ledger" });
  expect(await claim("w", 5, ["signal"])).toEqual([]);
  expect(await claim("w", 5, ["ledger"])).toHaveLength(1);
});

test("concurrent claimers never share a job (SKIP LOCKED)", async () => {
  await enqueueN(200);
  const seen: bigint[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async (_, w) => {
      for (;;) {
        const batch = await claim(`w${w}`, 7);
        if (batch.length === 0) return;
        seen.push(...batch.map((b) => b.id));
      }
    }),
  );
  expect(seen).toHaveLength(200);
  expect(new Set(seen).size).toBe(200);
});

test("abandoned job is reclaimed and the old owner cannot complete it", async () => {
  const [id] = await enqueueN();
  await claim("dead-worker", 1);
  await db().execute(sql`UPDATE jobs SET locked_at = now() - interval '5 minutes'`);
  const [reclaimed] = await claim("w2", 1);
  expect(reclaimed!.id).toBe(id);
  expect(reclaimed!.attempts).toBe(2);
  expect(await db().transaction((tx) => jobs.complete(tx, id!, "dead-worker"))).toBe(false);
  expect(await db().transaction((tx) => jobs.complete(tx, id!, "w2"))).toBe(true);
  expect((await job(id!)).status).toBe("succeeded");
});

test("fail retries with backoff, then dead-letters", async () => {
  const [id] = await enqueueN(1, { maxAttempts: 2 });
  const now = new Date();
  let [c] = await claim("w", 1);
  expect(await db().transaction((tx) => jobs.fail(tx, c!, { workerId: "w", error: "boom", now }))).toBe("queued");
  let row = await job(id!);
  expect(row.status).toBe("queued");
  expect(Date.parse(row.runAt.replace(" ", "T").replace(/\+00$/, "Z"))).toBeGreaterThan(now.getTime());
  expect(row.lastError).toBe("boom");
  await db().execute(sql`UPDATE jobs SET run_at = now() - interval '1 second'`);
  [c] = await claim("w", 1);
  expect(await db().transaction((tx) => jobs.fail(tx, c!, { workerId: "w", error: "boom again", now }))).toBe("dead");
  row = await job(id!);
  expect(row.status).toBe("dead");
  expect(row.finishedAt).not.toBeNull();
});

test("backoff is bounded", () => {
  for (let attempt = 1; attempt < 40; attempt++) {
    const d = jobs.backoffSeconds(attempt);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(jobs.BACKOFF_CAP_S);
  }
  expect(jobs.backoffSeconds(1)).toBeLessThanOrEqual(jobs.BACKOFF_BASE_S);
});

test("queue depth", async () => {
  await enqueueN(3);
  await claim("w", 1);
  expect(await jobs.queueDepth(db())).toEqual({ queued: 2, running: 1 });
});

describe("worker", () => {
  const worker = (registry: JobRegistry) => new Worker(db(), registry, { workerId: "test-worker", clock: new FrozenClock(new Date()) });

  test("success commits handler effects together with completion", async () => {
    const registry = new JobRegistry().register("test.kind", async (tx, j) => {
      await jobs.enqueue(tx, "test.followup", { parent: j.id });
    });
    const [id] = await enqueueN();
    expect(await worker(registry).runOnce()).toBe(1);
    expect((await job(id!)).status).toBe("succeeded");
    const kinds = (await db().select({ kind: jobs.jobs.kind }).from(jobs.jobs).orderBy(jobs.jobs.id)).map((r) => r.kind);
    expect(kinds).toEqual(["test.kind", "test.followup"]);
  });

  test("failure rolls back effects and reschedules", async () => {
    const registry = new JobRegistry().register("test.kind", async (tx) => {
      await jobs.enqueue(tx, "test.followup", {});
      throw new Error("downstream unavailable");
    });
    const [id] = await enqueueN();
    await worker(registry).runOnce();
    const row = await job(id!);
    expect(row.status).toBe("queued");
    expect(row.lastError).toContain("downstream unavailable");
    expect(await db().select().from(jobs.jobs).where(eq(jobs.jobs.kind, "test.followup"))).toEqual([]);
  });

  test("permanent error dead-letters immediately", async () => {
    const registry = new JobRegistry().register("test.kind", async () => {
      throw new PermanentJobError("payload references unknown station");
    });
    const [id] = await enqueueN();
    await worker(registry).runOnce();
    expect((await job(id!)).status).toBe("dead");
  });

  test("unknown kind dead-letters", async () => {
    const [id] = await enqueueN();
    await worker(new JobRegistry()).runOnce();
    const row = await job(id!);
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("no handler");
  });

  test("lease lost: work rolled back, nothing completed", async () => {
    const registry = new JobRegistry().register("test.kind", async (tx, j) => {
      await jobs.enqueue(tx, "test.followup", {});
      // Another worker steals the lease mid-run.
      await db().execute(sql`UPDATE jobs SET locked_by = 'thief' WHERE id = ${j.id}`);
    });
    const [id] = await enqueueN();
    await worker(registry).runOnce();
    expect((await job(id!)).lockedBy).toBe("thief");
    expect(await db().select().from(jobs.jobs).where(eq(jobs.jobs.kind, "test.followup"))).toEqual([]);
  });

  test("duplicate registration rejected", () => {
    const r = new JobRegistry().register("x", async () => undefined);
    expect(() => r.register("x", async () => undefined)).toThrow(/already registered/);
  });

  test("graceful stop: runForever drains and exits", async () => {
    const w = worker(new JobRegistry());
    const done = w.runForever();
    setTimeout(() => w.stop(), 50);
    await done;
    expect(w.stopped).toBe(true);
  });
});

describe("app/DB clock skew", () => {
  test("msUntilNextDue measures against the database clock", async () => {
    expect(await jobs.msUntilNextDue(db(), ["default"], 500)).toBeNull();
    await enqueueN(1, { runAt: new Date(Date.now() + 60_000) });
    expect(await jobs.msUntilNextDue(db(), ["default"], 500)).toBeNull(); // outside the window
    expect(await jobs.msUntilNextDue(db(), ["other"], 120_000)).toBeNull(); // other queue
    const ms = await jobs.msUntilNextDue(db(), ["default"], 120_000);
    expect(ms).toBeGreaterThan(50_000);
    await enqueueN(1);
    expect(await jobs.msUntilNextDue(db(), ["default"], 500)).toBe(0);
  });

  test("runDue waits for a job that is due a moment from now by the DB clock", async () => {
    const seen: number[] = [];
    const registry = new JobRegistry().register("test.kind", async () => void seen.push(1));
    const [id] = await enqueueN();
    await db().execute(sql`UPDATE jobs SET run_at = clock_timestamp() + interval '150 milliseconds' WHERE id = ${id!}`);
    const w = new Worker(db(), registry, { queues: ["default"], workerId: "skew" });
    expect(await w.runOnce()).toBe(0); // not due yet
    expect(await w.runDue()).toBe(1);
    expect(await w.runDue()).toBe(0); // idle: returns rather than waiting
    expect(seen).toEqual([1]);
  });
});
