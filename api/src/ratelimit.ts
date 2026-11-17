/**
 * Per-Station rate limiting with GCRA stored in Postgres (same algorithm as M1).
 * One atomic upsert per request on its own connection; fails open.
 */
import { sql } from "drizzle-orm";

import { type Db, log } from "@mintrail/shared";

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterS: number;
}

export class RateLimiter {
  constructor(private readonly db: Db) {}

  async acquire(bucket: string, ratePerS: number, burst: number): Promise<RateDecision> {
    const t = 1 / ratePerS;
    const tau = burst * t;
    let current = 0;
    try {
      const ahead = await this.db.transaction(async (tx) => {
        const res = await tx.execute<{ ahead: number }>(sql`
          INSERT INTO rate_limit_state AS r (bucket, tat)
          VALUES (${bucket}, clock_timestamp() + make_interval(secs => ${t}))
          ON CONFLICT (bucket) DO UPDATE
             SET tat = GREATEST(r.tat, clock_timestamp()) + make_interval(secs => ${t})
           WHERE GREATEST(r.tat, clock_timestamp()) + make_interval(secs => ${t}) - clock_timestamp()
                 <= make_interval(secs => ${tau})
          RETURNING EXTRACT(EPOCH FROM (tat - clock_timestamp()))::float8 AS ahead`);
        if (res.rows.length > 0) return Number(res.rows[0]!.ahead);
        const peek = await tx.execute<{ ahead: number }>(
          sql`SELECT EXTRACT(EPOCH FROM (tat - clock_timestamp()))::float8 AS ahead FROM rate_limit_state WHERE bucket = ${bucket}`,
        );
        current = Number(peek.rows[0]?.ahead ?? 0);
        return null;
      });
      if (ahead !== null) {
        return { allowed: true, limit: burst, remaining: Math.max(0, Math.floor((tau - ahead) / t + 1e-9)), retryAfterS: 0 };
      }
    } catch (err) {
      log.error({ err }, "rate limiter unavailable; allowing request");
      return { allowed: true, limit: burst, remaining: burst, retryAfterS: 0 };
    }
    return { allowed: false, limit: burst, remaining: 0, retryAfterS: Math.max(1, Math.ceil(current + t - tau)) };
  }
}
