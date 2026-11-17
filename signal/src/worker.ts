/**
 * Signal worker: LISTEN mintrail_outbox for immediate wake-ups, with polling as
 * the fallback (a missed NOTIFY — e.g. during a reconnect — only adds latency).
 */
import type pg from "pg";

import { log } from "@mintrail/shared";

import type { SignalEngine } from "./delivery.js";

export const CHANNEL = "mintrail_outbox";

export class SignalWorker {
  private stopping = false;
  private wake: (() => void) | undefined;
  private listener: pg.PoolClient | undefined;
  stopped = false;

  constructor(
    private readonly engine: SignalEngine,
    private readonly pool: pg.Pool,
    private readonly pollIntervalS: number,
  ) {}

  private async listen(): Promise<void> {
    try {
      this.listener = await this.pool.connect();
      this.listener.on("notification", () => this.wake?.());
      this.listener.on("error", (e) => {
        log.warn({ err: e.message }, "outbox listener lost; polling until it reconnects");
        this.listener = undefined;
      });
      await this.listener.query(`LISTEN ${CHANNEL}`);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "could not LISTEN; polling only");
    }
  }

  async runForever(): Promise<void> {
    await this.listen();
    log.info({ channel: CHANNEL }, "signal worker started");
    while (!this.stopping) {
      let busy = 0;
      try {
        busy = (await this.engine.dispatch()) + (await this.engine.deliverDue());
      } catch (e) {
        log.error({ err: (e as Error).message }, "signal loop error");
      }
      if (!this.listener && !this.stopping) await this.listen();
      if (busy === 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollIntervalS * 1000);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
    this.listener?.release();
    this.stopped = true;
    log.info("signal worker stopped");
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }
}
