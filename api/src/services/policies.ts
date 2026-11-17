/** Per-Station money policies (rolling reserve, payout limits); defaults come from settings. */
import { eq, sql } from "drizzle-orm";

import { InvalidRequestError, type Settings, type Tx } from "@mintrail/shared";

import { type StationPolicy, stationPolicies } from "../schema/index.js";

export async function getPolicy(tx: Tx, settings: Settings, stationId: string): Promise<StationPolicy> {
  const [p] = await tx.select().from(stationPolicies).where(eq(stationPolicies.stationId, stationId));
  return (
    p ?? {
      stationId,
      reserveBps: 0,
      reserveHoldDays: 0,
      payoutDailyLimit: settings.payout_daily_limit,
      payoutApprovalThreshold: settings.payout_approval_threshold,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

export async function updatePolicy(
  tx: Tx,
  settings: Settings,
  stationId: string,
  changes: Partial<Pick<StationPolicy, "reserveBps" | "reserveHoldDays" | "payoutDailyLimit" | "payoutApprovalThreshold">>,
): Promise<[StationPolicy, StationPolicy]> {
  const before = await getPolicy(tx, settings, stationId);
  const next = { ...before, ...changes };
  if (next.reserveBps < 0 || next.reserveBps > 5000)
    throw new InvalidRequestError("reserve_bps must be within 0..5000", { param: "reserve_bps" });
  if (next.reserveHoldDays < 0 || next.reserveHoldDays > 180)
    throw new InvalidRequestError("reserve_hold_days must be within 0..180", { param: "reserve_hold_days" });
  if (next.payoutDailyLimit <= 0n || next.payoutApprovalThreshold <= 0n) throw new InvalidRequestError("payout limits must be positive");
  const [row] = await tx
    .insert(stationPolicies)
    .values({ ...next, stationId, updatedAt: sql`now()` as unknown as string })
    .onConflictDoUpdate({
      target: stationPolicies.stationId,
      set: {
        reserveBps: next.reserveBps,
        reserveHoldDays: next.reserveHoldDays,
        payoutDailyLimit: next.payoutDailyLimit,
        payoutApprovalThreshold: next.payoutApprovalThreshold,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return [row!, before];
}
