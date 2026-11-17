/**
 * Generic job worker loop. Each job runs in its own transaction together with
 * its completion marker; handler effects and ``status = succeeded`` commit
 * atomically. SIGTERM/SIGINT drain gracefully: the current job finishes,
 * unstarted leases expire and are picked up elsewhere.
 */
import { hostname } from "node:os";

import { type Clock, systemClock } from "./clock.js";
import type { Db, Tx } from "./db.js";
import * as jobs from "./jobs.js";
import { log, logContext } from "./log.js";

export type Handler = (tx: Tx, job: jobs.ClaimedJob) => Promise<void>;

export class PermanentJobError extends Error {}
class LeaseLostError extends Error {}

export class JobRegistry {
  readonly handlers = new Map<string, Handler>();

  register(kind: string, handler: Handler): this {
    if (this.handlers.has(kind)) throw new Error(`handler for '${kind}' already registered`);
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: string): Handler | undefined {
    return this.handlers.get(kind);
  }
}

export const LOOP_ERROR_BACKOFF_CAP_S = 30;

export interface WorkerOptions {
  queues?: string[];
  workerId?: string;
  batchSize?: number;
  pollIntervalS?: number;
  visibilityTimeoutS?: number;
  clock?: Clock;
}

let workerSeq = 0;

export class Worker {
  readonly queues: string[];
  readonly workerId: string;
  private readonly batchSize: number;
  private readonly pollIntervalS: number;
  private readonly visibilityTimeoutS: number;
  private readonly clock: Clock;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly registry: JobRegistry,
    opts: WorkerOptions = {},
  ) {
    this.queues = opts.queues ?? [jobs.DEFAULT_QUEUE];
    workerSeq += 1;
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${workerSeq}`;
    this.batchSize = opts.batchSize ?? 10;
    this.pollIntervalS = opts.pollIntervalS ?? 1;
    this.visibilityTimeoutS = opts.visibilityTimeoutS ?? 300;
    this.clock = opts.clock ?? systemClock;
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  get stopped(): boolean {
    return this.stopping;
  }

  /** Claim one batch and process it. Returns the number of jobs handled. */
  /**
   * runOnce, but when nothing was claimable and a job on this worker's queues becomes due within
   * `skewMs` by the database clock, wait for it and try again. For tests and drains that need
   * "run everything that is due now" despite app/DB clock skew.
   */
  async runDue(skewMs = 500): Promise<number> {
    for (;;) {
      const n = await this.runOnce();
      if (n > 0) return n;
      const wait = await jobs.msUntilNextDue(this.db, this.queues, skewMs);
      if (wait === null) return 0;
      await new Promise((r) => setTimeout(r, wait + 5));
    }
  }

  async runOnce(): Promise<number> {
    const claimed = await this.db.transaction((tx) =>
      jobs.claim(tx, {
        queues: this.queues,
        workerId: this.workerId,
        limit: this.batchSize,
        visibilityTimeoutS: this.visibilityTimeoutS,
      }),
    );
    for (const job of claimed) {
      if (this.stopping) break; // lease will expire and another worker picks it up
      await logContext.run({ job_id: job.id.toString() }, () => this.process(job));
    }
    return claimed.length;
  }

  private async process(job: jobs.ClaimedJob): Promise<void> {
    const handler = this.registry.get(job.kind);
    if (!handler) {
      await this.recordFailure(job, `no handler registered for '${job.kind}'`, true);
      return;
    }
    try {
      await this.db.transaction(async (tx) => {
        await handler(tx, job);
        if (!(await jobs.complete(tx, job.id, this.workerId))) throw new LeaseLostError();
      });
      log.info({ kind: job.kind, attempt: job.attempts }, "job succeeded");
    } catch (err) {
      if (err instanceof LeaseLostError) {
        log.warn({ kind: job.kind }, "job lease lost; work rolled back");
      } else if (err instanceof PermanentJobError) {
        await this.recordFailure(job, `permanent: ${err.message}`, true);
      } else {
        const e = err as Error;
        log.error({ kind: job.kind, attempt: job.attempts, err: e }, "job failed");
        await this.recordFailure(job, `${e.name ?? "Error"}: ${e.message}`, false);
      }
    }
  }

  private async recordFailure(job: jobs.ClaimedJob, error: string, permanent: boolean): Promise<void> {
    const status = await this.db.transaction((tx) =>
      jobs.fail(tx, job, { workerId: this.workerId, error, now: this.clock.now(), permanent }),
    );
    if (status === jobs.JobStatus.DEAD) log.error({ kind: job.kind, error }, "job dead-lettered");
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, seconds * 1000);
      this.wake = () => {
        clearTimeout(t);
        this.wake = undefined;
        resolve();
      };
    });
  }

  async runForever(): Promise<void> {
    const onSignal = (signal: NodeJS.Signals) => {
      log.info({ signal }, "signal received; draining");
      this.stop();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    log.info({ worker_id: this.workerId, queues: this.queues }, "worker started");
    let consecutiveErrors = 0;
    while (!this.stopping) {
      let handled: number;
      try {
        handled = await this.runOnce();
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        const delay = Math.min(LOOP_ERROR_BACKOFF_CAP_S, this.pollIntervalS * 2 ** consecutiveErrors);
        log.error({ err, delay_s: delay }, "worker loop error; backing off");
        await this.sleep(delay);
        continue;
      }
      if (handled === 0) await this.sleep(this.pollIntervalS);
    }
    log.info({ worker_id: this.workerId }, "worker stopped");
  }
}
