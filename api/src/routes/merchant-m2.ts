/**
 * M2 merchant resources, registered twice with the same handlers:
 *   /v1/…            API key auth + scopes          (public API, SDK)
 *   /dashboard/v1/…  dashboard session + role check (merchant dashboard)
 */
import { ErrorCode, IdPrefix, InvalidRequestError, MintRailError, parseId, type Tx } from "@mintrail/shared";
import { deliveryOut, EndpointService, endpointOut, eventOut, signalOptions } from "@mintrail/signal";

import type { AppDeps } from "../deps.js";
import { disputeOut, fxRateOut, list, payoutBatchOut, payoutOut, refundOut, settlementEntryOut, settlementOut } from "../http/out.js";
import type { makeRoute, RouteSpec } from "../http/route.js";
import type { Scope } from "../scopes.js";
import type { DashboardPermission } from "../services/dashboard-auth.js";
import { DisputeService } from "../services/disputes.js";
import { PayoutService } from "../services/payouts.js";
import { RefundService } from "../services/refunds.js";
import { SettlementReader } from "../services/settlements.js";
import type { DisputeStatus, PayoutMode, PayoutStatus, RefundStatus } from "../schema/index.js";
import * as S from "./schemas-m2.js";
import { SCENARIO_HEADER } from "./v1.js";

type Guard = Pick<RouteSpec<undefined, undefined>, "merchant" | "dashboard">;

const DASH_PERMISSION: Record<Scope, DashboardPermission> = {
  "station:read": "read",
  "station:write": "api_keys",
  "balance:read": "read",
  "orders:read": "read",
  "orders:write": "refunds",
  "payments:read": "read",
  "payments:write": "refunds",
  "refunds:read": "read",
  "refunds:write": "refunds",
  "disputes:read": "read",
  "disputes:write": "disputes",
  "payouts:read": "read",
  "payouts:write": "payouts",
  "settlements:read": "read",
  "webhooks:read": "read",
  "webhooks:write": "webhooks",
  "events:read": "read",
};

export function endpointService(deps: AppDeps, tx: Tx): EndpointService {
  const o = signalOptions(deps.settings);
  return new EndpointService(tx, {
    secretBox: o.secretBox,
    allowLocal: o.allowPrivate,
    graceS: o.graceS,
    maxAttempts: o.maxAttempts,
    clock: deps.clock,
  });
}

export function merchantM2Routes(route: ReturnType<typeof makeRoute>, deps: AppDeps, surface: "v1" | "dashboard"): void {
  const P = surface === "v1" ? "/v1" : "/dashboard/v1";
  const g = (scope: Scope): Guard => (surface === "v1" ? { merchant: { scope } } : { dashboard: DASH_PERMISSION[scope] });
  const refunds = (tx: Tx) => new RefundService(tx, deps.settings, deps.junction, deps.clock);
  const disputes = (tx: Tx) => new DisputeService(tx, deps.settings, deps.junction, deps.clock);
  const payouts = (tx: Tx) => new PayoutService(tx, deps.settings, deps.junction, deps.clock);
  const actor = (c: { dash?: { user: { email: string } }; auth?: { apiKey?: { id: string } } }) =>
    c.dash ? `user:${c.dash.user.email}` : `api_key:${c.auth?.apiKey?.id ?? "unknown"}`;
  const scenario = (h: string | undefined) => (h === undefined ? null : h);

  // ---------------------------------------------------------------- refunds
  route("post", `${P}/payments/:payment_id/refunds`, { ...g("refunds:write"), idempotent: true, body: S.RefundCreateIn }, async (c) => {
    const sc = scenario(c.req.get(SCENARIO_HEADER));
    return c.idem.run(async (tx) => {
      const r = await refunds(tx).create(c.principal, parseId(c.params.payment_id!, IdPrefix.PAYMENT, "payment_id"), {
        amount: c.body.amount ?? null,
        reason: c.body.reason,
        speed: c.body.speed,
        notes: (c.body.notes as Record<string, unknown> | null | undefined) ?? null,
        scenario: sc,
      });
      return { status: 201, body: refundOut(r) };
    });
  });

  route("get", `${P}/refunds`, { ...g("refunds:read"), query: S.RefundListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.REFUND, "starting_after");
    const [rows, more] = await refunds(deps.db).list(c.principal, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      paymentId: c.query.payment_id,
      status: (c.query.status ?? null) as RefundStatus | null,
    });
    return { status: 200, body: list(rows.map(refundOut), more) };
  });

  route("get", `${P}/refunds/:refund_id`, g("refunds:read"), async (c) => ({
    status: 200,
    body: refundOut(await refunds(deps.db).get(c.principal, parseId(c.params.refund_id!, IdPrefix.REFUND))),
  }));

  route("get", `${P}/payments/:payment_id/refunds`, g("refunds:read"), async (c) => {
    const [rows, more] = await refunds(deps.db).list(c.principal, {
      limit: 100,
      paymentId: parseId(c.params.payment_id!, IdPrefix.PAYMENT),
    });
    return { status: 200, body: list(rows.map(refundOut), more) };
  });

  // ---------------------------------------------------------------- disputes
  route("get", `${P}/disputes`, { ...g("disputes:read"), query: S.DisputeListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.DISPUTE, "starting_after");
    const [rows, more] = await disputes(deps.db).list(c.principal, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      status: (c.query.status ?? null) as DisputeStatus | null,
      paymentId: c.query.payment_id,
    });
    return {
      status: 200,
      body: list(
        rows.map((d) => disputeOut(d)),
        more,
      ),
    };
  });

  route("get", `${P}/disputes/:dispute_id`, g("disputes:read"), async (c) => {
    const svc = disputes(deps.db);
    const d = await svc.get(c.principal, parseId(c.params.dispute_id!, IdPrefix.DISPUTE));
    return { status: 200, body: disputeOut(d, await svc.evidence(d.id)) };
  });

  route("get", `${P}/disputes/:dispute_id/evidence/:file_id`, g("disputes:read"), async (c) => {
    const f = await disputes(deps.db).evidenceFile(
      c.principal,
      parseId(c.params.dispute_id!, IdPrefix.DISPUTE),
      parseId(c.params.file_id!, IdPrefix.EVIDENCE_FILE),
    );
    return { status: 200, body: null, raw: { contentType: f.contentType, body: f.content, filename: f.filename } };
  });

  route(
    "post",
    `${P}/disputes/:dispute_id/evidence`,
    {
      ...g("disputes:write"),
      body: S.EvidenceForm,
      upload: { field: "files", maxFiles: deps.settings.evidence_max_files, maxBytes: deps.settings.evidence_max_bytes },
    },
    async (c) => {
      const [d, files] = await deps.db.transaction((tx) =>
        disputes(tx).addEvidence(c.principal, parseId(c.params.dispute_id!, IdPrefix.DISPUTE), {
          files: c.files,
          kind: c.body.kind,
          text: c.body.text ?? null,
          uploadedBy: actor(c),
        }),
      );
      return { status: 200, body: disputeOut(d, files) };
    },
  );

  for (const action of ["submit", "accept"] as const) {
    route("post", `${P}/disputes/:dispute_id/${action}`, { ...g("disputes:write"), idempotent: true }, async (c) =>
      c.idem.run(async (tx) => {
        const svc = disputes(tx);
        const id = parseId(c.params.dispute_id!, IdPrefix.DISPUTE);
        const d = action === "submit" ? await svc.submit(c.principal, id) : await svc.accept(c.principal, id);
        return { status: 200, body: disputeOut(d, await svc.evidence(d.id)) };
      }),
    );
  }

  route(
    "post",
    `${P}/payments/:payment_id/simulate_dispute`,
    { ...g("disputes:write"), idempotent: true, body: S.SimulateDisputeIn },
    async (c) => {
      if (c.principal.livemode) throw new InvalidRequestError("disputes can only be simulated in test mode");
      return c.idem.run(async (tx) => {
        const res = await disputes(tx).simulate(
          parseId(c.params.payment_id!, IdPrefix.PAYMENT),
          { amount: c.body.amount ?? null, reason: c.body.reason, outcome: c.body.outcome ?? null },
          c.principal.station.id,
        );
        return { status: 202, body: { object: "dispute_simulation", network_reference: res.ref, status: "requested" } };
      });
    },
  );

  // ---------------------------------------------------------------- payouts
  route("post", `${P}/payouts`, { ...g("payouts:write"), idempotent: true, body: S.PayoutCreateIn }, async (c) => {
    const sc = scenario(c.req.get(SCENARIO_HEADER));
    return c.idem.run(async (tx) => {
      const p = await payouts(tx).create(
        c.principal,
        {
          ...c.body,
          mode: c.body.mode as PayoutMode,
          beneficiary: { ...c.body.beneficiary, ifsc: c.body.beneficiary.ifsc?.toUpperCase() },
        },
        { scenario: sc },
      );
      return { status: 201, body: payoutOut(p) };
    });
  });

  route("get", `${P}/payouts`, { ...g("payouts:read"), query: S.PayoutListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.PAYOUT, "starting_after");
    const [rows, more] = await payouts(deps.db).list(c.principal, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      status: (c.query.status ?? null) as PayoutStatus | null,
      batchId: c.query.batch_id,
    });
    return { status: 200, body: list(rows.map(payoutOut), more) };
  });

  route("get", `${P}/payouts/:payout_id`, g("payouts:read"), async (c) => ({
    status: 200,
    body: payoutOut(await payouts(deps.db).get(c.principal, parseId(c.params.payout_id!, IdPrefix.PAYOUT))),
  }));

  route("post", `${P}/payouts/:payout_id/cancel`, { ...g("payouts:write"), idempotent: true }, async (c) =>
    c.idem.run(async (tx) => ({
      status: 200,
      body: payoutOut(await payouts(tx).cancel(c.principal, parseId(c.params.payout_id!, IdPrefix.PAYOUT))),
    })),
  );

  route(
    "post",
    `${P}/payouts/bulk`,
    { ...g("payouts:write"), upload: { field: "file", maxFiles: 1, maxBytes: 1024 * 1024 } },
    async (c) => {
      const file = c.files[0];
      if (!file) throw new InvalidRequestError("attach the CSV as 'file'", { param: "file" });
      const text = file.buffer.toString("utf8");
      if (text.includes("\u0000")) throw new InvalidRequestError("file is not a text CSV", { param: "file" });
      const [batch, items] = await deps.db.transaction((tx) =>
        payouts(tx).bulk(c.principal, { csv: text, filename: file.originalname, createdBy: actor(c) }),
      );
      return { status: 201, body: payoutBatchOut(batch, items) };
    },
  );

  route("get", `${P}/payout_batches/:batch_id`, g("payouts:read"), async (c) => {
    const [b, items] = await payouts(deps.db).batch(c.principal, parseId(c.params.batch_id!, IdPrefix.PAYOUT_BATCH));
    return { status: 200, body: payoutBatchOut(b, items) };
  });

  // ---------------------------------------------------------------- webhooks & events
  const owner = (c: { principal: { station: { id: string }; livemode: boolean } }) => ({
    stationId: c.principal.station.id,
    livemode: c.principal.livemode,
  });

  route("post", `${P}/webhook_endpoints`, { ...g("webhooks:write"), idempotent: true, body: S.WebhookEndpointIn }, async (c) =>
    c.idem.run(async (tx) => {
      const [ep, secret] = await endpointService(deps, tx).create(owner(c), {
        url: c.body.url,
        description: c.body.description ?? null,
        enabled_events: c.body.enabled_events ?? undefined,
      });
      return { status: 201, body: { ...endpointOut(ep), secret } };
    }),
  );

  route("get", `${P}/webhook_endpoints`, g("webhooks:read"), async (c) => ({
    status: 200,
    body: list((await endpointService(deps, deps.db).list(owner(c))).map(endpointOut), false),
  }));

  route("get", `${P}/webhook_endpoints/:endpoint_id`, g("webhooks:read"), async (c) => ({
    status: 200,
    body: endpointOut(await endpointService(deps, deps.db).get(owner(c), parseId(c.params.endpoint_id!, IdPrefix.WEBHOOK))),
  }));

  route("patch", `${P}/webhook_endpoints/:endpoint_id`, { ...g("webhooks:write"), body: S.WebhookEndpointPatch }, async (c) => {
    const ep = await deps.db.transaction((tx) =>
      endpointService(deps, tx).update(owner(c), parseId(c.params.endpoint_id!, IdPrefix.WEBHOOK), {
        url: c.body.url,
        description: c.body.description,
        enabled_events: c.body.enabled_events,
        status: c.body.status,
      }),
    );
    return { status: 200, body: endpointOut(ep) };
  });

  route("delete", `${P}/webhook_endpoints/:endpoint_id`, g("webhooks:write"), async (c) => {
    const ep = await deps.db.transaction((tx) =>
      endpointService(deps, tx).remove(owner(c), parseId(c.params.endpoint_id!, IdPrefix.WEBHOOK)),
    );
    return { status: 200, body: endpointOut(ep) };
  });

  route("post", `${P}/webhook_endpoints/:endpoint_id/rotate_secret`, { ...g("webhooks:write"), idempotent: true }, async (c) =>
    c.idem.run(async (tx) => {
      const [ep, secret] = await endpointService(deps, tx).rotateSecret(owner(c), parseId(c.params.endpoint_id!, IdPrefix.WEBHOOK));
      return { status: 200, body: { ...endpointOut(ep), secret } };
    }),
  );

  route("get", `${P}/webhook_deliveries`, { ...g("webhooks:read"), query: S.DeliveryListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.WEBHOOK_DELIVERY, "starting_after");
    const [rows, more] = await endpointService(deps, deps.db).deliveries(owner(c), {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      endpointId: c.query.endpoint_id,
      eventId: c.query.event_id,
      status: c.query.status,
    });
    return {
      status: 200,
      body: list(
        rows.map((d) => deliveryOut(d)),
        more,
      ),
    };
  });

  route("get", `${P}/webhook_deliveries/:delivery_id`, g("webhooks:read"), async (c) => {
    const [d, attempts] = await endpointService(deps, deps.db).delivery(
      owner(c),
      parseId(c.params.delivery_id!, IdPrefix.WEBHOOK_DELIVERY),
    );
    return { status: 200, body: deliveryOut(d, attempts) };
  });

  route("post", `${P}/webhook_deliveries/:delivery_id/replay`, { ...g("webhooks:write"), idempotent: true }, async (c) =>
    c.idem.run(async (tx) => ({
      status: 201,
      body: deliveryOut(await endpointService(deps, tx).replay(owner(c), parseId(c.params.delivery_id!, IdPrefix.WEBHOOK_DELIVERY))),
    })),
  );

  route("get", `${P}/events`, { ...g("events:read"), query: S.EventListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.EVENT, "starting_after");
    const [rows, more] = await endpointService(deps, deps.db).events(owner(c), {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      type: c.query.type,
    });
    return { status: 200, body: list(rows.map(eventOut), more) };
  });

  route("get", `${P}/events/:event_id`, g("events:read"), async (c) => ({
    status: 200,
    body: eventOut(await endpointService(deps, deps.db).event(owner(c), parseId(c.params.event_id!, IdPrefix.EVENT))),
  }));

  // ---------------------------------------------------------------- settlements & FX
  route("get", `${P}/settlements`, { ...g("settlements:read"), query: S.SettlementListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.SETTLEMENT, "starting_after");
    const [rows, more] = await new SettlementReader(deps.db).list(c.principal, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      from: c.query.from,
      to: c.query.to,
      status: c.query.status,
    });
    return { status: 200, body: list(rows.map(settlementOut), more) };
  });

  route("get", `${P}/settlements/:settlement_id`, g("settlements:read"), async (c) => ({
    status: 200,
    body: settlementOut(await new SettlementReader(deps.db).get(c.principal, parseId(c.params.settlement_id!, IdPrefix.SETTLEMENT))),
  }));

  route("get", `${P}/settlements/:settlement_id/entries`, g("settlements:read"), async (c) => {
    const r = new SettlementReader(deps.db);
    const s = await r.get(c.principal, parseId(c.params.settlement_id!, IdPrefix.SETTLEMENT));
    return { status: 200, body: list((await r.entries(s.id)).map(settlementEntryOut), false) };
  });

  route("get", `${P}/settlements/:settlement_id/report`, g("settlements:read"), async (c) => {
    const [s, csv] = await new SettlementReader(deps.db).reportCsv(c.principal, parseId(c.params.settlement_id!, IdPrefix.SETTLEMENT));
    return {
      status: 200,
      body: null,
      raw: { contentType: "text/csv; charset=utf-8", body: csv, filename: `settlement-${s.settlementDate}-${s.id}.csv` },
    };
  });

  route("get", `${P}/fx_rates/latest`, { ...g("settlements:read"), query: S.FxQuery }, async (c) => {
    const r = await new SettlementReader(deps.db).latestFx(c.query.base, c.query.quote);
    if (!r) throw new MintRailError("no FX snapshot recorded yet", { code: ErrorCode.FX_RATE_UNAVAILABLE });
    return { status: 200, body: fxRateOut(r) };
  });
}
