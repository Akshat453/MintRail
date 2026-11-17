/** Junction worker job handlers. */
import { JobRegistry, type Settings } from "@mintrail/shared";

import { Bank, JOB_DECIDE, JOB_DELIVER, JOB_RESOLVE } from "./bank.js";
import { deliver, type Fetch } from "./callbacks.js";
import { BankOps, JOB_DISPUTE_DECIDE, JOB_PAYOUT_RESOLVE, JOB_REFUND_RESOLVE } from "./ops.js";

export function buildRegistry(settings: Settings, fetchImpl: Fetch): JobRegistry {
  const secret = Buffer.from(settings.junction_callback_secret, "utf8");
  return new JobRegistry()
    .register(JOB_DECIDE, (tx, job) => new Bank(tx, settings).decide(job.payload.ref as string))
    .register(JOB_RESOLVE, (tx, job) => new Bank(tx, settings).resolve(job.payload.ref as string))
    .register(JOB_REFUND_RESOLVE, (tx, job) => new BankOps(tx, settings).resolveRefund(job.payload.ref as string))
    .register(JOB_DISPUTE_DECIDE, (tx, job) => new BankOps(tx, settings).decideDispute(job.payload.ref as string))
    .register(JOB_PAYOUT_RESOLVE, (tx, job) => new BankOps(tx, settings).resolvePayout(job.payload.ref as string))
    .register(JOB_DELIVER, async (_tx, job) => {
      await deliver(fetchImpl, settings.junction_callback_url, secret, job.payload, Math.floor(Date.now() / 1000));
    });
}
