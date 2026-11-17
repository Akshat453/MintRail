/** Dashboard / Railyard read models: volume and success-rate series (IST days), balances, method mix. */
import { sql } from "drizzle-orm";

import { type Tx } from "@mintrail/shared";
import { LedgerService } from "@mintrail/ledger";

const BALANCE_KINDS = ["merchant_balance", "reserve", "dispute_reserve"] as const;

export interface OverviewOpts {
  stationId: string;
  livemode: boolean;
  days: number;
  currency?: string;
}

export async function overview(tx: Tx, o: OverviewOpts) {
  const since = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date - ${o.days - 1}::int`;
  const daily = await tx.execute<{
    day: string;
    attempts: string;
    succeeded: string;
    failed: string;
    volume: string;
  }>(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           count(p.id)::text AS attempts,
           count(p.id) FILTER (WHERE p.status = 'captured')::text AS succeeded,
           count(p.id) FILTER (WHERE p.status = 'failed')::text AS failed,
           coalesce(sum(p.amount) FILTER (WHERE p.status = 'captured'), 0)::text AS volume
      FROM generate_series(${since}, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') AS d(day)
      LEFT JOIN payments p
        ON p.station_id = ${o.stationId} AND p.livemode = ${o.livemode} AND p.currency = ${o.currency ?? "INR"}
       AND (p.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day
     GROUP BY d.day ORDER BY d.day`);
  const mix = await tx.execute<{ method: string; n: string; volume: string }>(sql`
    SELECT method, count(*)::text AS n, coalesce(sum(amount), 0)::text AS volume
      FROM payments
     WHERE station_id = ${o.stationId} AND livemode = ${o.livemode} AND status = 'captured'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${since}
     GROUP BY method ORDER BY method`);
  const [refundRow] = (
    await tx.execute<{ n: string; amount: string }>(sql`
    SELECT count(*)::text AS n, coalesce(sum(amount), 0)::text AS amount FROM refunds
     WHERE station_id = ${o.stationId} AND livemode = ${o.livemode} AND status <> 'failed'
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${since}`)
  ).rows;
  const [disputeRow] = (
    await tx.execute<{ open: string; total: string }>(sql`
    SELECT count(*) FILTER (WHERE status IN ('needs_response','under_review'))::text AS open, count(*)::text AS total
      FROM disputes WHERE station_id = ${o.stationId} AND livemode = ${o.livemode}`)
  ).rows;
  const balances: Record<string, Record<string, bigint>> = {};
  for (const b of await new LedgerService(tx).balancesForOwner(o.stationId, o.livemode)) {
    const [, , , kind, cur] = b.code.split(":");
    if (!(BALANCE_KINDS as readonly string[]).includes(kind!)) continue;
    (balances[cur!] ??= {})[kind!] = b.balance.amount;
  }
  const series = daily.rows.map((r) => ({
    date: r.day,
    attempts: BigInt(r.attempts),
    succeeded: BigInt(r.succeeded),
    failed: BigInt(r.failed),
    volume: BigInt(r.volume),
  }));
  const succeeded = series.reduce((a, r) => a + r.succeeded, 0n);
  const failed = series.reduce((a, r) => a + r.failed, 0n);
  const volume = series.reduce((a, r) => a + r.volume, 0n);
  return {
    object: "overview",
    livemode: o.livemode,
    currency: o.currency ?? "INR",
    days: o.days,
    totals: {
      volume,
      payments: succeeded,
      failed,
      // basis points, integer: 9234 = 92.34%
      success_rate_bps: succeeded + failed === 0n ? null : (succeeded * 10_000n) / (succeeded + failed),
      average_ticket: succeeded === 0n ? null : volume / succeeded,
      refunds: BigInt(refundRow?.n ?? "0"),
      refunded_amount: BigInt(refundRow?.amount ?? "0"),
      open_disputes: BigInt(disputeRow?.open ?? "0"),
      disputes: BigInt(disputeRow?.total ?? "0"),
    },
    method_mix: mix.rows.map((r) => ({ method: r.method, payments: BigInt(r.n), volume: BigInt(r.volume) })),
    balances,
    series,
  };
}
