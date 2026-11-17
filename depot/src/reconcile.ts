/**
 * Reconciliation (ADR-0014): settlement totals vs the ledger, every night after
 * the settlement run. A report row is written either way; mismatches are items.
 *
 * Checks
 *   settlement_entries_sum   Σ entries.amount            = settlements.amount
 *   settlement_ledger        settlement_initiated debit  = settlements.amount (merchant_balance)
 *   settlement_paid          processed ⇒ settlement_paid = payout_amount
 *   item_ledger              each payment / refund / payout entry = its own ledger movement
 *   balance_identity         merchant_balance (ledger)   = Σ source-table movements
 *                                                          + Σ sweep entries − Σ settlements
 *   ledger_cache             cached balances = Σ postings   (LedgerService.reconcile)
 *   trial_balance            debits = credits per currency and mode
 */
import { sql } from "drizzle-orm";

import { type Clock, CURRENCIES, type Currency, IdPrefix, newId, systemClock, type Tx } from "@mintrail/shared";
import { reconciliationItems, reconciliationReports, type ReconciliationReport } from "@mintrail/api";
import { LedgerService } from "@mintrail/ledger";

interface Mismatch {
  stationId?: string | null;
  livemode?: boolean | null;
  currency?: string | null;
  check: string;
  referenceId?: string | null;
  expected?: bigint | null;
  actual?: bigint | null;
  detail?: string | null;
}

const big = (v: unknown): bigint => BigInt(String(v ?? 0));

export async function reconcile(tx: Tx, clock: Clock = systemClock): Promise<[ReconciliationReport, Mismatch[]]> {
  const out: Mismatch[] = [];

  // 1-3: each settlement against its entries and its ledger transactions.
  const st = await tx.execute<{
    id: string;
    station_id: string;
    livemode: boolean;
    currency: string;
    amount: string;
    payout_amount: string;
    status: string;
    entries_sum: string | null;
    initiated: string | null;
    paid: string | null;
  }>(sql`
    SELECT s.id, s.station_id, s.livemode, s.currency, s.amount::text, s.payout_amount::text, s.status,
           (SELECT sum(e.amount) FROM settlement_entries e WHERE e.settlement_id = s.id)::text AS entries_sum,
           (SELECT sum(p.amount) FROM ledger_transactions t JOIN ledger_postings p ON p.transaction_id = t.id
              JOIN ledger_accounts a ON a.id = p.account_id
             WHERE t.idempotency_key = 'settlement_initiated:' || s.id AND p.direction = 'debit'
               AND a.code LIKE 'station:%:merchant_balance:%')::text AS initiated,
           (SELECT sum(p.amount) FROM ledger_transactions t JOIN ledger_postings p ON p.transaction_id = t.id
             WHERE t.idempotency_key = 'settlement_paid:' || s.id AND p.direction = 'debit')::text AS paid
      FROM settlements s ORDER BY s.id`);
  for (const s of st.rows) {
    const base = { stationId: s.station_id, livemode: s.livemode, currency: s.currency, referenceId: s.id };
    if (big(s.entries_sum) !== big(s.amount))
      out.push({ ...base, check: "settlement_entries_sum", expected: big(s.amount), actual: big(s.entries_sum) });
    if (big(s.initiated) !== big(s.amount))
      out.push({ ...base, check: "settlement_ledger", expected: big(s.amount), actual: big(s.initiated) });
    if (s.status === "processed" && big(s.amount) > 0n && big(s.paid) !== big(s.payout_amount)) {
      out.push({ ...base, check: "settlement_paid", expected: big(s.payout_amount), actual: big(s.paid) });
    }
  }

  // 4: every settled payment / refund / payout matches its own merchant_balance movement.
  const items = await tx.execute<{
    kind: string;
    reference_id: string;
    amount: string;
    ledger: string | null;
    station_id: string;
    livemode: boolean;
    currency: string;
  }>(sql`
    SELECT e.kind, e.reference_id, e.amount::text, s.station_id, s.livemode, s.currency,
           (SELECT sum(CASE WHEN p.direction = 'credit' THEN p.amount ELSE -p.amount END)
              FROM ledger_transactions t JOIN ledger_postings p ON p.transaction_id = t.id
              JOIN ledger_accounts a ON a.id = p.account_id
             WHERE a.code LIKE 'station:%:merchant_balance:%'
               AND t.idempotency_key = ANY (CASE e.kind
                     WHEN 'payment' THEN ARRAY['capture:' || e.reference_id]
                     WHEN 'refund' THEN ARRAY['refund_initiated:' || e.reference_id, 'refund_fee:' || e.reference_id]
                     WHEN 'refund_reversal' THEN ARRAY['refund_failed:' || e.reference_id, 'refund_fee_reversed:' || e.reference_id]
                     WHEN 'payout' THEN ARRAY['payout_initiated:' || e.reference_id]
                     WHEN 'payout_reversal' THEN ARRAY['payout_reversed:' || e.reference_id]
                   END))::text AS ledger
      FROM settlement_entries e JOIN settlements s ON s.id = e.settlement_id
     WHERE e.kind IN ('payment','refund','refund_reversal','payout','payout_reversal')`);
  for (const i of items.rows) {
    if (big(i.ledger) !== big(i.amount)) {
      out.push({
        stationId: i.station_id,
        livemode: i.livemode,
        currency: i.currency,
        check: "item_ledger",
        referenceId: `${i.kind}:${i.reference_id}`,
        expected: big(i.amount),
        actual: big(i.ledger),
      });
    }
  }

  // 5: merchant balance identity per (station, mode, currency).
  const bal = await tx.execute<{ station_id: string; livemode: boolean; currency: string; ledger: string; expected: string }>(sql`
    WITH accts AS (
      SELECT a.owner_id AS station_id, a.livemode, a.currency, b.credits_total - b.debits_total AS ledger
        FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
       WHERE a.code LIKE 'station:%:merchant_balance:%'
    ), moves AS (
      SELECT station_id, livemode, currency, sum(amount - coalesce(fee, 0) - coalesce(tax, 0)) AS m
        FROM payments WHERE status = 'captured' GROUP BY 1, 2, 3
      UNION ALL
      SELECT station_id, livemode, currency, -sum(amount + fee + tax) FROM refunds GROUP BY 1, 2, 3
      UNION ALL
      SELECT station_id, livemode, currency, sum(amount + fee + tax) FROM refunds WHERE status = 'failed' GROUP BY 1, 2, 3
      UNION ALL
      SELECT station_id, livemode, currency, -sum(amount) FROM payouts GROUP BY 1, 2, 3
      UNION ALL
      SELECT station_id, livemode, currency, sum(amount) FROM payouts WHERE status IN ('failed','rejected','cancelled') GROUP BY 1, 2, 3
      UNION ALL
      SELECT s.station_id, s.livemode, s.currency, sum(e.amount) FROM settlement_entries e JOIN settlements s ON s.id = e.settlement_id
       WHERE e.kind IN ('reserve_hold','reserve_release','dispute_recovery','dispute_release') GROUP BY 1, 2, 3
      UNION ALL
      SELECT station_id, livemode, currency, -sum(amount) FROM settlements GROUP BY 1, 2, 3
    )
    SELECT a.station_id, a.livemode, a.currency, a.ledger::text,
           coalesce((SELECT sum(m) FROM moves WHERE moves.station_id = a.station_id AND moves.livemode = a.livemode AND moves.currency = a.currency), 0)::text AS expected
      FROM accts a`);
  for (const b of bal.rows) {
    if (big(b.ledger) !== big(b.expected)) {
      out.push({
        stationId: b.station_id,
        livemode: b.livemode,
        currency: b.currency,
        check: "balance_identity",
        expected: big(b.expected),
        actual: big(b.ledger),
      });
    }
  }

  // 6-7: ledger internals.
  const ledger = new LedgerService(tx, clock);
  for (const d of await ledger.reconcile()) {
    out.push({
      check: "ledger_cache",
      referenceId: d.code,
      expected: d.actual_debits - d.actual_credits,
      actual: d.cached_debits - d.cached_credits,
    });
  }
  for (const livemode of [false, true]) {
    for (const currency of CURRENCIES as readonly Currency[]) {
      const tb = await ledger.trialBalance(currency, livemode);
      if (!tb.isBalanced) out.push({ livemode, currency, check: "trial_balance", expected: tb.debits.amount, actual: tb.credits.amount });
    }
  }

  const stationsChecked = new Set(bal.rows.map((b) => b.station_id)).size;
  const [report] = await tx
    .insert(reconciliationReports)
    .values({
      id: newId(IdPrefix.RECONCILIATION, BigInt(clock.now().getTime())),
      runAt: clock.now().toISOString(),
      status: out.length === 0 ? "ok" : "mismatch",
      stationsChecked,
      settlementsChecked: st.rows.length,
      mismatchCount: out.length,
      totals: {
        settled_amount: st.rows.reduce((a, s) => a + big(s.amount), 0n),
        items_checked: BigInt(items.rows.length),
        balances_checked: BigInt(bal.rows.length),
      },
    })
    .returning();
  for (let i = 0; i < out.length; i += 500) {
    await tx.insert(reconciliationItems).values(
      out.slice(i, i + 500).map((m) => ({
        reportId: report!.id,
        stationId: m.stationId ?? null,
        livemode: m.livemode ?? null,
        currency: m.currency ?? null,
        check: m.check,
        referenceId: m.referenceId ?? null,
        expected: m.expected ?? null,
        actual: m.actual ?? null,
        detail: m.detail ?? null,
      })),
    );
  }
  return [report!, out];
}
