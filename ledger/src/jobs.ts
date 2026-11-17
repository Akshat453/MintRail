/** Background jobs owned by the Ledger. */
import { type ClaimedJob, JobRegistry, log, type Tx } from "@mintrail/shared";

import { LedgerService } from "./service.js";

export const RECONCILE_BALANCES = "ledger.reconcile_balances";

/**
 * Compare cached balances with the sum of postings. A discrepancy means the
 * balance cache was written outside LedgerService — a Derailment, not
 * something to auto-correct.
 */
export async function reconcileBalances(tx: Tx, job: ClaimedJob): Promise<void> {
  const discrepancies = await new LedgerService(tx).reconcile();
  if (discrepancies.length > 0) {
    log.error(
      { derailment: "ledger_balance_drift", accounts: discrepancies.map((d) => d.code), count: discrepancies.length },
      "DERAILMENT: ledger balance cache drift detected",
    );
  } else {
    log.info({ job_kind: job.kind }, "ledger balances reconciled");
  }
}

export const registry = new JobRegistry().register(RECONCILE_BALANCES, reconcileBalances);
