/** Merchant dashboard API (/dashboard/v1): sessions, overview analytics, filtered lists, keys, reports. */
import { and, asc, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";

import { addDays, ErrorCode, IdPrefix, InvalidRequestError, istStartOf, NotFoundError, parseId, type Tx } from "@mintrail/shared";
import { eventOut, outboxEvents } from "@mintrail/signal";

import type { AppDeps } from "../deps.js";
import { clientIp } from "../http/middleware.js";
import { apiKeyOut, dashboardUserOut, disputeOut, list, paymentOut, refundOut, stationOut } from "../http/out.js";
import { type makeRoute, stationService } from "../http/route.js";
import { disputes, type KeyMode, payments, refunds } from "../schema/index.js";
import { overview } from "../services/analytics.js";
import { DASHBOARD_PERMISSIONS, DashboardAuthService } from "../services/dashboard-auth.js";
import { paymentsReport, payoutsReport, refundsReport, settlementsReport } from "../services/settlements.js";
import type { DashboardRole } from "../schema/index.js";
import { merchantM2Routes } from "./merchant-m2.js";
import * as S from "./schemas-m2.js";

export function dashboardRoutes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  const auth = (tx: Tx) => new DashboardAuthService(tx, deps.settings, deps.clock);

  route("post", "/dashboard/v1/auth/login", { body: S.DashboardLoginIn }, async (c) => {
    const result = await deps.db.transaction(async (tx) => {
      try {
        return {
          ok: await auth(tx).login(c.body.email, c.body.password, { ip: clientIp(c.req), userAgent: c.req.get("user-agent") ?? null }),
        };
      } catch (e) {
        return { err: e }; // commit the failed-login counter, then rethrow
      }
    });
    if ("err" in result) throw result.err;
    const [user, token] = result.ok;
    const station = await stationService(deps, deps.db).get(user.stationId);
    return {
      status: 200,
      body: {
        token,
        expires_in: deps.settings.dashboard_session_ttl_s,
        user: dashboardUserOut(user),
        station: stationOut(station),
        permissions: DASHBOARD_PERMISSIONS[user.role as DashboardRole],
      },
    };
  });

  route("post", "/dashboard/v1/auth/logout", { dashboard: "any" }, async (c) => {
    await deps.db.transaction((tx) => auth(tx).logout(c.dash.sessionId));
    return { status: 204, body: undefined };
  });

  route("get", "/dashboard/v1/me", { dashboard: "any" }, async (c) => ({
    status: 200,
    body: {
      user: dashboardUserOut(c.dash.user),
      station: stationOut(c.dash.station),
      livemode: c.dash.livemode,
      permissions: DASHBOARD_PERMISSIONS[c.dash.user.role as DashboardRole],
    },
  }));

  route("get", "/dashboard/v1/overview", { dashboard: "read", query: S.OverviewQuery }, async (c) => ({
    status: 200,
    body: await overview(deps.db, {
      stationId: c.dash.station.id,
      livemode: c.dash.livemode,
      days: c.query.days,
      currency: c.query.currency,
    }),
  }));

  route("get", "/dashboard/v1/payments", { dashboard: "read", query: S.DashboardPaymentQuery }, async (c) => {
    const q = c.query;
    if (q.starting_after) parseId(q.starting_after, IdPrefix.PAYMENT, "starting_after");
    const where: SQL[] = [eq(payments.stationId, c.dash.station.id), eq(payments.livemode, c.dash.livemode)];
    if (q.starting_after) where.push(lt(payments.id, q.starting_after));
    if (q.status) where.push(eq(payments.status, q.status));
    if (q.method) where.push(eq(payments.method, q.method));
    if (q.from) where.push(gte(payments.createdAt, istStartOf(q.from).toISOString()));
    if (q.to) where.push(lt(payments.createdAt, istStartOf(addDays(q.to, 1)).toISOString()));
    if (q.q) {
      const term = q.q.trim();
      where.push(
        or(eq(payments.id, term), eq(payments.orderId, term), ilike(payments.customerEmail, `%${term.replace(/[%_\\]/g, "\\$&")}%`))!,
      );
    }
    const rows = await deps.db
      .select()
      .from(payments)
      .where(and(...where))
      .orderBy(desc(payments.id))
      .limit(q.limit + 1);
    return { status: 200, body: list(rows.slice(0, q.limit).map(paymentOut), rows.length > q.limit) };
  });

  route("get", "/dashboard/v1/payments/:payment_id", { dashboard: "read" }, async (c) => {
    const id = parseId(c.params.payment_id!, IdPrefix.PAYMENT);
    const [p] = await deps.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.stationId, c.dash.station.id), eq(payments.livemode, c.dash.livemode)));
    if (!p) throw new NotFoundError(`payment ${id} not found`, { code: ErrorCode.PAYMENT_NOT_FOUND });
    const [rf, ds, ev] = await Promise.all([
      deps.db.select().from(refunds).where(eq(refunds.paymentId, id)).orderBy(asc(refunds.id)),
      deps.db.select().from(disputes).where(eq(disputes.paymentId, id)).orderBy(asc(disputes.id)),
      deps.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.stationId, c.dash.station.id),
            eq(outboxEvents.livemode, c.dash.livemode),
            sql`(${outboxEvents.data} -> 'object' ->> 'id' = ${id} OR ${outboxEvents.data} -> 'object' ->> 'payment_id' = ${id})`,
          ),
        )
        .orderBy(asc(outboxEvents.seq))
        .limit(50),
    ]);
    return {
      status: 200,
      body: { ...paymentOut(p), refunds: rf.map(refundOut), disputes: ds.map((d) => disputeOut(d)), events: ev.map(eventOut) },
    };
  });

  // ---------------------------------------------------------------- API keys (secrets shown once)
  route("get", "/dashboard/v1/api_keys", { dashboard: "api_keys" }, async (c) => ({
    status: 200,
    body: list((await stationService(deps, deps.db).listKeys(c.dash.station.id)).map(apiKeyOut), false),
  }));

  route("post", "/dashboard/v1/api_keys", { dashboard: "api_keys", idempotent: true, body: S.DashboardKeyIn }, async (c) =>
    c.idem.run(async (tx) => {
      const [row, gen] = await stationService(deps, tx).issueKey(
        c.dash.station.id,
        c.body.mode as KeyMode,
        c.body.scopes ?? null,
        c.body.label ?? null,
      );
      return { status: 201, body: { ...apiKeyOut(row), secret: gen.secret } };
    }),
  );

  route("post", "/dashboard/v1/api_keys/:key_id/revoke", { dashboard: "api_keys", idempotent: true }, async (c) =>
    c.idem.run(async (tx) => {
      const svc = stationService(deps, tx);
      const keyId = parseId(c.params.key_id!, IdPrefix.API_KEY);
      if (!(await svc.listKeys(c.dash.station.id)).some((k) => k.id === keyId)) throw new NotFoundError(`api key ${keyId} not found`);
      return { status: 200, body: apiKeyOut(await svc.revokeKey(keyId)) };
    }),
  );

  // ---------------------------------------------------------------- reports (CSV)
  const REPORTS = { payments: paymentsReport, refunds: refundsReport, settlements: settlementsReport, payouts: payoutsReport } as const;
  route("get", "/dashboard/v1/reports/:kind", { dashboard: "reports", query: S.ReportQuery }, async (c) => {
    const kind = c.params.kind!.replace(/\.csv$/, "") as keyof typeof REPORTS;
    const make = REPORTS[kind];
    if (!make) throw new NotFoundError(`unknown report '${kind}'`);
    if (c.query.to < c.query.from) throw new InvalidRequestError("'to' must not be before 'from'", { param: "to" });
    const csv = await make(deps.db, c.dash, istStartOf(c.query.from).toISOString(), istStartOf(addDays(c.query.to, 1)).toISOString());
    return {
      status: 200,
      body: null,
      raw: {
        contentType: "text/csv; charset=utf-8",
        body: csv,
        filename: `${kind}-${c.dash.livemode ? "live" : "test"}-${c.query.from}-to-${c.query.to}.csv`,
      },
    };
  });

  merchantM2Routes(route, deps, "dashboard");
}
