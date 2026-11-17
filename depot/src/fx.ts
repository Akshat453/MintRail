/** FX snapshots (ADR-0017): one stored USD→INR rate per day, fetched from Junction's simulated feed. */
import { and, eq, sql } from "drizzle-orm";

import { type Clock, IdPrefix, istStartOf, newId, parseRate, systemClock, type Tx } from "@mintrail/shared";
import { type FxRate, fxRates, type JunctionClient } from "@mintrail/api";

export interface FxFeed {
  rate(base: string, quote: string, date: string): Promise<{ rate: string; source: string }>;
}

export const junctionFeed = (j: JunctionClient): FxFeed => ({
  rate: async (base, quote, date) => {
    const r = await j.fxRate(base, quote, date);
    return { rate: r.rate, source: r.source };
  },
});

/** The snapshot for ``date`` (IST), fetching and storing it on first use. */
export async function snapshotFor(
  tx: Tx,
  feed: FxFeed,
  base: string,
  quote: string,
  date: string,
  clock: Clock = systemClock,
): Promise<FxRate> {
  const asOf = istStartOf(date).toISOString();
  const [existing] = await tx
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.base, base), eq(fxRates.quote, quote), eq(fxRates.asOf, sql`${asOf}::timestamptz`)));
  if (existing) return existing;
  const q = await feed.rate(base, quote, date);
  const [row] = await tx
    .insert(fxRates)
    .values({ id: newId(IdPrefix.FX_RATE, BigInt(clock.now().getTime())), base, quote, rate: parseRate(q.rate), source: q.source, asOf })
    .returning();
  return row!;
}
