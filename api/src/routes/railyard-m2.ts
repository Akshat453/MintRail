/** Railyard M2: disputes, payout approvals, webhook replay, settlements & reconciliation, policies, merchant users, Derailments. */
import { and, desc, eq, lt } from "drizzle-orm";

import { enqueue, IdPrefix, istDate, parseId, type Tx } from "@mintrail/shared";
import { deliveryOut } from "@mintrail/signal";

import type { AppDeps } from "../deps.js";
import { DEPOT_QUEUE, JOB_DEPOT_RECONCILE, JOB_DEPOT_RUN } from "../depot-jobs.js";
import { clientIp } from "../http/middleware.js";
import {
  dashboardUserOut,
  derailmentOut,
  disputeOut,
  list,
  paymentOut,
  payoutOut,
  policyOut,
  reconciliationOut,
  refundOut,
  settlementEntryOut,
  settlementOut,
} from "../http/out.js";
import type { makeRoute } from "../http/route.js";
import { payments, refunds, type DashboardRole, type DisputeStatus, type PayoutStatus } from "../schema/index.js";
import { overview } from "../services/analytics.js";
import { AuditService } from "../services/audit.js";
import { DashboardAuthService } from "../services/dashboard-auth.js";
import { DerailmentService } from "../services/derailments.js";
import { DisputeService } from "../services/disputes.js";
import { PayoutService } from "../services/payouts.js";
import { getPolicy, updatePolicy } from "../services/policies.js";
import { SettlementReader } from "../services/settlements.js";
import { endpointService } from "./merchant-m2.js";
import * as S from "./schemas-m2.js";
import { ListQuery } from "./schemas.js";

export function railyardM2Routes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  const audit = (tx: Tx, req: Parameters<typeof clientIp>[0]) => new AuditService(tx, clientIp(req));
  const disputes = (tx: Tx) => new DisputeService(tx, deps.settings, deps.junction, deps.clock);
  const payouts = (tx: Tx) => new PayoutService(tx, deps.settings, deps.junction, deps.clock);
  const sid = (v: string) => parseId(v, IdPrefix.STATION);

  // ---------------------------------------------------------------- merchant lookup
  route("get", "/internal/v1/stations/:station_id/overview", { staff: "stations:read", query: S.StationOverviewQuery }, async (c) => ({
    status: 200,
    body: await overview(deps.db, { stationId: sid(c.params.station_id!), livemode: c.query.livemode === "true", days: c.query.days }),
  }));

  route("get", "/internal/v1/stations/:station_id/payments", { staff: "payments:read", query: ListQuery }, async (c) => {
    const where = [eq(payments.stationId, sid(c.params.station_id!))];
    if (c.query.starting_after) where.push(lt(payments.id, parseId(c.query.starting_after, IdPrefix.PAYMENT, "starting_after")));
    const rows = await deps.db
      .select()
      .from(payments)
      .where(and(...where))
      .orderBy(desc(payments.id))
      .limit(c.query.limit + 1);
    return {
      status: 200,
      body: list(
        rows.slice(0, c.query.limit).map((p) => ({ ...paymentOut(p), station_id: p.stationId })),
        rows.length > c.query.limit,
      ),
    };
  });

  route("get", "/internal/v1/payments/:payment_id/refunds", { staff: "payments:read" }, async (c) => ({
    status: 200,
    body: list(
      (
        await deps.db
          .select()
          .from(refunds)
          .where(eq(refunds.paymentId, parseId(c.params.payment_id!, IdPrefix.PAYMENT)))
          .orderBy(refunds.id)
      ).map(refundOut),
      false,
    ),
  }));

  route("get", "/internal/v1/stations/:station_id/policy", { staff: "stations:read" }, async (c) => ({
    status: 200,
    body: policyOut(await getPolicy(deps.db, deps.settings, sid(c.params.station_id!))),
  }));

  route("patch", "/internal/v1/stations/:station_id/policy", { staff: "stations:write", body: S.PolicyIn }, async (c) => {
    const id = sid(c.params.station_id!);
    const p = await deps.db.transaction(async (tx) => {
      const [after, before] = await updatePolicy(tx, deps.settings, id, {
        ...(c.body.reserve_bps != null ? { reserveBps: c.body.reserve_bps } : {}),
        ...(c.body.reserve_hold_days != null ? { reserveHoldDays: c.body.reserve_hold_days } : {}),
        ...(c.body.payout_daily_limit != null ? { payoutDailyLimit: c.body.payout_daily_limit } : {}),
        ...(c.body.payout_approval_threshold != null ? { payoutApprovalThreshold: c.body.payout_approval_threshold } : {}),
      });
      await audit(tx, c.req).record(c.staff, "station.policy_update", {
        targetType: "station",
        targetId: id,
        details: { before: policyOut(before), after: policyOut(after) },
      });
      return after;
    });
    return { status: 200, body: policyOut(p) };
  });

  route("get", "/internal/v1/stations/:station_id/dashboard_users", { staff: "stations:read" }, async (c) => ({
    status: 200,
    body: list((await new DashboardAuthService(deps.db, deps.settings).listUsers(sid(c.params.station_id!))).map(dashboardUserOut), false),
  }));

  route("post", "/internal/v1/stations/:station_id/dashboard_users", { staff: "stations:write", body: S.DashboardUserIn }, async (c) => {
    const u = await deps.db.transaction(async (tx) => {
      const user = await new DashboardAuthService(tx, deps.settings, deps.clock).createUser({
        stationId: sid(c.params.station_id!),
        email: c.body.email,
        fullName: c.body.full_name,
        role: c.body.role as DashboardRole,
        password: c.body.password,
      });
      await audit(tx, c.req).record(c.staff, "dashboard_user.create", {
        targetType: "dashboard_user",
        targetId: user.id,
        details: { station_id: user.stationId, role: user.role },
      });
      return user;
    });
    return { status: 201, body: dashboardUserOut(u) };
  });

  // ---------------------------------------------------------------- disputes
  route("get", "/internal/v1/disputes", { staff: "payments:read", query: S.DisputeListQuery }, async (c) => {
    const [rows, more] = await disputes(deps.db).list(null, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      status: (c.query.status ?? null) as DisputeStatus | null,
      paymentId: c.query.payment_id,
      stationId: c.query.station_id,
    });
    return {
      status: 200,
      body: list(
        rows.map((d) => ({ ...disputeOut(d), station_id: d.stationId })),
        more,
      ),
    };
  });

  route("get", "/internal/v1/disputes/:dispute_id", { staff: "payments:read" }, async (c) => {
    const svc = disputes(deps.db);
    const d = await svc.get(null, parseId(c.params.dispute_id!, IdPrefix.DISPUTE));
    return { status: 200, body: { ...disputeOut(d, await svc.evidence(d.id)), station_id: d.stationId } };
  });

  route("get", "/internal/v1/disputes/:dispute_id/evidence/:file_id", { staff: "disputes:manage" }, async (c) => {
    const f = await disputes(deps.db).evidenceFile(
      null,
      parseId(c.params.dispute_id!, IdPrefix.DISPUTE),
      parseId(c.params.file_id!, IdPrefix.EVIDENCE_FILE),
    );
    return { status: 200, body: null, raw: { contentType: f.contentType, body: f.content, filename: f.filename } };
  });

  for (const action of ["submit", "accept"] as const) {
    route("post", `/internal/v1/disputes/:dispute_id/${action}`, { staff: "disputes:manage" }, async (c) => {
      const d = await deps.db.transaction(async (tx) => {
        const svc = disputes(tx);
        const id = parseId(c.params.dispute_id!, IdPrefix.DISPUTE);
        const out =
          action === "submit"
            ? await svc.submit(null, id)
            : await svc.accept(null, id, "accepted by MintRail ops on the merchant's behalf");
        await audit(tx, c.req).record(c.staff, `dispute.${action}`, {
          targetType: "dispute",
          targetId: out.id,
          details: { station_id: out.stationId },
        });
        return out;
      });
      return { status: 200, body: disputeOut(d) };
    });
  }

  route(
    "post",
    "/internal/v1/payments/:payment_id/simulate_dispute",
    { staff: "disputes:manage", body: S.SimulateDisputeIn },
    async (c) => {
      const id = parseId(c.params.payment_id!, IdPrefix.PAYMENT);
      const res = await deps.db.transaction(async (tx) => {
        const r = await disputes(tx).simulate(id, {
          amount: c.body.amount ?? null,
          reason: c.body.reason,
          outcome: c.body.outcome ?? null,
        });
        await audit(tx, c.req).record(c.staff, "dispute.simulate", {
          targetType: "payment",
          targetId: id,
          details: { network_reference: r.ref },
        });
        return r;
      });
      return { status: 202, body: { object: "dispute_simulation", network_reference: res.ref, status: "requested" } };
    },
  );

  // ---------------------------------------------------------------- payouts (single approver)
  route("get", "/internal/v1/payouts", { staff: "payments:read", query: S.PayoutListQuery }, async (c) => {
    const [rows, more] = await payouts(deps.db).list(null, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      status: (c.query.status ?? null) as PayoutStatus | null,
      stationId: c.query.station_id,
    });
    return {
      status: 200,
      body: list(
        rows.map((p) => ({ ...payoutOut(p), station_id: p.stationId })),
        more,
      ),
    };
  });

  route("post", "/internal/v1/payouts/:payout_id/approve", { staff: "payouts:approve" }, async (c) => {
    const p = await deps.db.transaction(async (tx) => {
      const out = await payouts(tx).approve(c.staff.staff.id, parseId(c.params.payout_id!, IdPrefix.PAYOUT));
      await audit(tx, c.req).record(c.staff, "payout.approve", {
        targetType: "payout",
        targetId: out.id,
        details: { station_id: out.stationId, amount: out.amount },
      });
      return out;
    });
    return { status: 200, body: payoutOut(p) };
  });

  route("post", "/internal/v1/payouts/:payout_id/reject", { staff: "payouts:approve", body: S.RejectIn }, async (c) => {
    const p = await deps.db.transaction(async (tx) => {
      const out = await payouts(tx).reject(c.staff.staff.id, parseId(c.params.payout_id!, IdPrefix.PAYOUT), c.body.reason);
      await audit(tx, c.req).record(c.staff, "payout.reject", {
        targetType: "payout",
        targetId: out.id,
        details: { station_id: out.stationId, reason: c.body.reason },
      });
      return out;
    });
    return { status: 200, body: payoutOut(p) };
  });

  // ---------------------------------------------------------------- webhook replay
  route("get", "/internal/v1/webhook_deliveries", { staff: "webhooks:replay", query: S.DeliveryListQuery }, async (c) => {
    const svc = endpointService(deps, deps.db);
    const [rows, more] = await svc.deliveries(null, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      endpointId: c.query.endpoint_id,
      eventId: c.query.event_id,
      status: c.query.status,
      stationId: c.query.station_id,
    });
    return {
      status: 200,
      body: list(
        rows.map((d) => ({ ...deliveryOut(d), station_id: d.stationId })),
        more,
      ),
    };
  });

  route("get", "/internal/v1/webhook_deliveries/:delivery_id", { staff: "webhooks:replay" }, async (c) => {
    const [d, attempts] = await endpointService(deps, deps.db).delivery(null, parseId(c.params.delivery_id!, IdPrefix.WEBHOOK_DELIVERY));
    return { status: 200, body: { ...deliveryOut(d, attempts), station_id: d.stationId } };
  });

  route("post", "/internal/v1/webhook_deliveries/:delivery_id/replay", { staff: "webhooks:replay" }, async (c) => {
    const d = await deps.db.transaction(async (tx) => {
      const out = await endpointService(deps, tx).replay(null, parseId(c.params.delivery_id!, IdPrefix.WEBHOOK_DELIVERY));
      await audit(tx, c.req).record(c.staff, "webhook.replay", {
        targetType: "webhook_delivery",
        targetId: out.replayOf,
        details: { station_id: out.stationId, new_delivery: out.id },
      });
      return out;
    });
    return { status: 201, body: deliveryOut(d) };
  });

  // ---------------------------------------------------------------- settlements & reconciliation
  route("get", "/internal/v1/settlements", { staff: "settlements:read", query: S.SettlementListQuery }, async (c) => {
    const [rows, more] = await new SettlementReader(deps.db).list(null, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      stationId: c.query.station_id,
      from: c.query.from,
      to: c.query.to,
      status: c.query.status,
    });
    return {
      status: 200,
      body: list(
        rows.map((s) => ({ ...settlementOut(s), station_id: s.stationId })),
        more,
      ),
    };
  });

  route("get", "/internal/v1/settlements/:settlement_id", { staff: "settlements:read" }, async (c) => {
    const r = new SettlementReader(deps.db);
    const s = await r.get(null, parseId(c.params.settlement_id!, IdPrefix.SETTLEMENT));
    return {
      status: 200,
      body: { ...settlementOut(s), station_id: s.stationId, entries: (await r.entries(s.id)).map(settlementEntryOut) },
    };
  });

  route("post", "/internal/v1/settlements/run", { staff: "settlements:run", body: S.SettlementRunIn }, async (c) => {
    const date = c.body.date ?? istDate(deps.clock.now());
    await deps.db.transaction(async (tx) => {
      await enqueue(tx, JOB_DEPOT_RUN, { date, requested_by: c.staff.staff.id }, { queue: DEPOT_QUEUE });
      await audit(tx, c.req).record(c.staff, "settlement.run_requested", { targetType: "settlement_run", targetId: date });
    });
    return { status: 202, body: { object: "settlement_run", date, status: "queued" } };
  });

  route("get", "/internal/v1/reconciliation/latest", { staff: "settlements:read" }, async () => {
    const r = await new SettlementReader(deps.db).latestReconciliation();
    return { status: 200, body: r ? reconciliationOut(r[0], r[1]) : { object: "reconciliation_report", status: "never_run" } };
  });

  route("post", "/internal/v1/reconciliation/run", { staff: "settlements:run" }, async (c) => {
    await deps.db.transaction(async (tx) => {
      await enqueue(tx, JOB_DEPOT_RECONCILE, { requested_by: c.staff.staff.id }, { queue: DEPOT_QUEUE });
      await audit(tx, c.req).record(c.staff, "reconciliation.run_requested", {});
    });
    return { status: 202, body: { object: "reconciliation_run", status: "queued" } };
  });

  // ---------------------------------------------------------------- Derailments
  route("get", "/internal/v1/derailments", { staff: "any", query: S.DerailmentQuery }, async (c) => ({
    status: 200,
    body: list(
      (await new DerailmentService(deps.db).list(c.query.limit, c.query.status)).map((d) => derailmentOut(d)),
      false,
    ),
  }));

  route("post", "/internal/v1/derailments", { staff: "derailments:write", body: S.DerailmentIn }, async (c) => {
    const d = await deps.db.transaction(async (tx) => {
      const out = await new DerailmentService(tx).create(c.staff.staff.id, c.body);
      await audit(tx, c.req).record(c.staff, "derailment.open", {
        targetType: "derailment",
        targetId: out.id,
        details: { severity: out.severity, title: out.title },
      });
      return out;
    });
    return { status: 201, body: derailmentOut(d, []) };
  });

  route("get", "/internal/v1/derailments/:derailment_id", { staff: "any" }, async (c) => {
    const [d, notes] = await new DerailmentService(deps.db).get(parseId(c.params.derailment_id!, IdPrefix.DERAILMENT));
    return { status: 200, body: derailmentOut(d, notes) };
  });

  route("post", "/internal/v1/derailments/:derailment_id/notes", { staff: "derailments:write", body: S.DerailmentNoteIn }, async (c) => {
    const [d, notes] = await deps.db.transaction(async (tx) => {
      const out = await new DerailmentService(tx).addNote(
        c.staff.staff.id,
        parseId(c.params.derailment_id!, IdPrefix.DERAILMENT),
        c.body.body,
        c.body.status,
      );
      await audit(tx, c.req).record(c.staff, "derailment.note", {
        targetType: "derailment",
        targetId: out[0].id,
        details: { status: c.body.status ?? null },
      });
      return out;
    });
    return { status: 200, body: derailmentOut(d, notes) };
  });
}
