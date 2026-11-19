/** Merchant dashboard API (/dashboard/v1): sessions, overview analytics, filtered lists, keys, reports. */
import { and, asc, desc, eq, gte, ilike, lt, ne, or, sql, type SQL } from "drizzle-orm";

import {
  addDays,
  apiTime,
  ErrorCode,
  IdPrefix,
  InvalidRequestError,
  istStartOf,
  NotFoundError,
  parseId,
  RateLimitedError,
  type Tx,
} from "@mintrail/shared";
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

  route("post", "/dashboard/v1/auth/signup", { body: S.DashboardSignupIn }, async (c) => {
    if (deps.settings.rate_limiting_enabled) {
      const decision = await deps.rateLimiter.acquire(`signup:${clientIp(c.req) ?? "unknown"}`, 0.05, 5);
      if (!decision.allowed) throw new RateLimitedError("too many sign-ups from this address; try again shortly", decision.retryAfterS);
    }
    const [user, token, station] = await deps.db.transaction(async (tx) => {
      const [created] = await stationService(deps, tx).createStation({
        legalName: c.body.legal_name ?? c.body.business_name,
        displayName: c.body.business_name,
        email: c.body.email,
        businessCategory: c.body.business_category,
        defaultCurrency: "INR",
        settings: {},
      });
      const a = auth(tx);
      await a.createUser({
        stationId: created.id,
        email: c.body.email,
        fullName: c.body.full_name,
        role: "owner",
        password: c.body.password,
      });
      const [u, t] = await a.login(c.body.email, c.body.password, { ip: clientIp(c.req), userAgent: c.req.get("user-agent") ?? null });
      return [u, t, created] as const;
    });
    return {
      status: 201,
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
    const where: SQL[] = [eq(payments.stationId, c.dash.station.id), eq(payments.livemode, c.dash.livemode)];
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
      .orderBy(desc(payments.createdAt))
      .limit(q.limit + 1)
      .offset((q.page - 1) * q.limit);
    // The list shows how much of each payment has been refunded.
    const data = [];
    for (const p of rows.slice(0, q.limit)) {
      const [r] = await deps.db
        .select({ refunded: sql<string>`coalesce(sum(${refunds.amount}), 0)::text` })
        .from(refunds)
        .where(and(eq(refunds.paymentId, p.id), ne(refunds.status, "failed")));
      data.push({ ...paymentOut(p), amount_refunded: BigInt(r!.refunded) });
    }
    return { status: 200, body: { ...list(data, rows.length > q.limit), page: BigInt(q.page) } };
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

  route("post", "/dashboard/v1/api_keys/:key_id/rotate", { dashboard: "api_keys", idempotent: true }, async (c) =>
    c.idem.run(async (tx) => {
      const svc = stationService(deps, tx);
      const keyId = parseId(c.params.key_id!, IdPrefix.API_KEY);
      if (!(await svc.listKeys(c.dash.station.id)).some((k) => k.id === keyId)) throw new NotFoundError(`api key ${keyId} not found`);
      const [row, generated, old] = await svc.rotateKey(keyId, deps.settings.api_key_rotation_grace_s);
      return {
        status: 201,
        body: { ...apiKeyOut(row), secret: generated.secret, replaces: old.id, replaced_key_expires_at: apiTime(old.expiresAt) },
      };
    }),
  );

  // ---------------------------------------------------------------- reports (CSV)
  const REPORTS = { payments: paymentsReport, refunds: refundsReport, settlements: settlementsReport, payouts: payoutsReport } as const;
  route("get", "/dashboard/v1/reports/:kind", { dashboard: "reports", query: S.ReportQuery }, async (c) => {
    const kind = c.params.kind!.replace(/\.csv$/, "") as keyof typeof REPORTS;
    const make = REPORTS[kind];
    if (!make) throw new NotFoundError(`unknown report '${kind}'`);
    if (c.query.to < c.query.from) throw new InvalidRequestError("'to' must not be before 'from'", { param: "to" });
    // Exports scan up to 100k rows; keep bursts of them from swamping the database.
    // The bucket is per station: a merchant is only throttled by its own exports (MR-10).
    if (deps.settings.rate_limiting_enabled) {
      const decision = await deps.rateLimiter.acquire(`reports:${c.dash.station.id}:${kind}`, 1, 10);
      if (!decision.allowed) throw new RateLimitedError("too many report exports; try again shortly", decision.retryAfterS);
    }
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
