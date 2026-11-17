/** Payments worker job handlers (queue ``payments``). */
import { type Clock, JobRegistry, type Settings, systemClock, type Tx } from "@mintrail/shared";

import type { JunctionClient } from "./junction-client.js";
import { JOB_CAPTURE, JOB_EXPIRE, JOB_STATUS_CHECK, JOB_SUBMIT, JOB_VOID, PaymentService } from "./services/payments.js";
import { DisputeService, JOB_DISPUTE_DEADLINE } from "./services/disputes.js";
import { JOB_PAYOUT_SUBMIT, PayoutService } from "./services/payouts.js";
import { JOB_REFUND_SUBMIT, RefundService } from "./services/refunds.js";

export function buildRegistry(settings: Settings, junction: JunctionClient, clock: Clock = systemClock): JobRegistry {
  const svc = (tx: Tx) => new PaymentService(tx, settings, junction, clock);
  return new JobRegistry()
    .register(JOB_SUBMIT, (tx, job) => svc(tx).submit(job.payload.payment_id as string))
    .register(JOB_STATUS_CHECK, (tx, job) => svc(tx).statusCheck(job.payload.payment_id as string, Number(job.payload.attempt ?? 1)))
    .register(JOB_CAPTURE, async (tx, job) => {
      await svc(tx).capture(job.payload.payment_id as string);
    })
    .register(JOB_VOID, (tx, job) => svc(tx).void(job.payload.payment_id as string, job.payload.reason as string))
    .register(JOB_EXPIRE, (tx, job) => svc(tx).expireAuthorization(job.payload.payment_id as string))
    .register(JOB_REFUND_SUBMIT, (tx, job) => new RefundService(tx, settings, junction, clock).submit(job.payload.refund_id as string))
    .register(JOB_PAYOUT_SUBMIT, (tx, job) => new PayoutService(tx, settings, junction, clock).submit(job.payload.payout_id as string))
    .register(JOB_DISPUTE_DEADLINE, (tx, job) =>
      new DisputeService(tx, settings, junction, clock).deadline(job.payload.dispute_id as string),
    );
}
