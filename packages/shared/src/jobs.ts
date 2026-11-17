/**
 * Postgres-backed job queue (FOR UPDATE SKIP LOCKED). Same table and semantics
 * as M1 (ADR-0004):
 *
 *     queued ──claim──▶ running ──complete──▶ succeeded
 *        ▲                 │
 *        └──fail (retry)───┤
 *                          └──fail (exhausted / permanent)──▶ dead
 */
import { and, eq, sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";

import { jsonbExact, type Tx } from "./db.js";
import { parseJson } from "./json.js";

export const DEFAULT_QUEUE = "default";
export const BACKOFF_BASE_S = 2;
export const BACKOFF_CAP_S = 3600;

export const JobStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  DEAD: "dead",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    queue: varchar("queue", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 128 }).notNull(),
    payload: jsonbExact<Record<string, unknown>>("payload").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    runAt: timestamp("run_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    lockedBy: varchar("locked_by", { length: 128 }),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    dedupeKey: varchar("dedupe_key", { length: 200 }).unique("uq_jobs_dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_jobs", columns: [t.id] }),
    index("ix_jobs_claimable")
      .on(t.queue, t.runAt)
      .where(sql`status = 'queued'`),
    index("ix_jobs_running_locked_at")
      .on(t.lockedAt)
      .where(sql`status = 'running'`),
  ],
);

export interface ClaimedJob {
  id: bigint;
  queue: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string | null;
}

/** Insert a job in the caller's transaction. Returns null if ``dedupeKey`` already exists. */
export async function enqueue(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<bigint | null> {
  const maxAttempts = opts.maxAttempts ?? 10;
  if (maxAttempts < 1) throw new RangeError("max_attempts must be >= 1");
  const values = {
    queue: opts.queue ?? DEFAULT_QUEUE,
    kind,
    payload,
    status: JobStatus.QUEUED,
    attempts: 0,
    maxAttempts,
    dedupeKey: opts.dedupeKey ?? null,
    ...(opts.runAt ? { runAt: opts.runAt.toISOString() } : {}),
  };
  const q = tx.insert(jobs).values(values);
  const rows = await (opts.dedupeKey ? q.onConflictDoNothing({ target: jobs.dedupeKey }) : q).returning({
    id: jobs.id,
  });
  return rows[0]?.id ?? null;
}

/** Atomically lease up to ``limit`` jobs. Caller must commit promptly. */
export async function claim(
  tx: Tx,
  opts: { queues: string[]; workerId: string; limit: number; visibilityTimeoutS: number },
): Promise<ClaimedJob[]> {
  const res = await tx.execute<{
    id: bigint;
    queue: string;
    kind: string;
    payload: string;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE jobs AS j
       SET status = 'running',
           locked_by = ${opts.workerId},
           locked_at = now(),
           attempts = j.attempts + 1,
           updated_at = now()
     WHERE j.id IN (
           SELECT id FROM jobs
            WHERE queue IN (${sql.join(
              opts.queues.map((q) => sql`${q}`),
              sql`, `,
            )})
              AND (
                    (status = 'queued' AND run_at <= now())
                 OR (status = 'running' AND locked_at < now() - make_interval(secs => ${opts.visibilityTimeoutS}))
              )
            ORDER BY run_at, id
            LIMIT ${opts.limit}
            FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.queue, j.kind, j.payload::text AS payload, j.attempts, j.max_attempts`);
  return res.rows
    .map((r) => ({
      id: BigInt(r.id),
      queue: r.queue,
      kind: r.kind,
      payload: parseJson(r.payload) as Record<string, unknown>,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Mark a leased job succeeded. Returns false if we no longer own the lease. */
export async function complete(tx: Tx, jobId: bigint, workerId: string): Promise<boolean> {
  const rows = await tx
    .update(jobs)
    .set({
      status: JobStatus.SUCCEEDED,
      finishedAt: sql`now()`,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, JobStatus.RUNNING)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Exponential backoff with full jitter, capped. */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** Math.max(0, attempt - 1));
  return ceiling / 2 + random() * (ceiling / 2);
}

/** Reschedule with backoff, or bury as dead. Returns the new status, or null if the lease was lost. */
export async function fail(
  tx: Tx,
  job: ClaimedJob,
  opts: { workerId: string; error: string; now: Date; permanent?: boolean },
): Promise<JobStatus | null> {
  const exhausted = opts.permanent === true || job.attempts >= job.maxAttempts;
  const base = { lastError: opts.error.slice(0, 4000), lockedBy: null, lockedAt: null, updatedAt: sql`now()` };
  const values = exhausted
    ? { ...base, status: JobStatus.DEAD, finishedAt: opts.now.toISOString() }
    : {
        ...base,
        status: JobStatus.QUEUED,
        runAt: new Date(opts.now.getTime() + backoffSeconds(job.attempts) * 1000).toISOString(),
      };
  const rows = await tx
    .update(jobs)
    .set(values)
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, opts.workerId), eq(jobs.status, JobStatus.RUNNING)))
    .returning({ id: jobs.id });
  if (rows.length === 0) return null;
  return exhausted ? JobStatus.DEAD : JobStatus.QUEUED;
}

export async function queueDepth(tx: Tx, queue = DEFAULT_QUEUE): Promise<Record<string, number>> {
  const res = await tx.execute<{ status: string; n: bigint }>(
    sql`SELECT status, count(*) AS n FROM jobs WHERE queue = ${queue} GROUP BY status`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Milliseconds until the earliest queued job on `queues` becomes due by the *database* clock
 * (0 if one is due now), or null if none is queued within `withinMs`. Jobs are scheduled from
 * the application clock but claimed against Postgres `now()`, so a job enqueued "now" can be a
 * few ms in the future when the two clocks differ (e.g. Postgres in a Docker VM).
 */
export async function msUntilNextDue(tx: Tx, queues: string[], withinMs: number): Promise<number | null> {
  const res = await tx.execute<{ ms: string | null }>(
    sql`SELECT (EXTRACT(EPOCH FROM (min(run_at) - clock_timestamp())) * 1000)::text AS ms
        FROM jobs
        WHERE status = 'queued' AND queue IN (${sql.join(
          queues.map((q) => sql`${q}`),
          sql`, `,
        )}) AND run_at <= clock_timestamp() + make_interval(secs => ${withinMs / 1000})`,
  );
  const ms = res.rows[0]?.ms;
  return ms == null ? null : Math.max(0, Math.ceil(Number(ms)));
}
