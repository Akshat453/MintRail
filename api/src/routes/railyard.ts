/** Railyard (internal ops) endpoints under ``/internal/v1`` — staff session auth, audited. */
import { asc, eq } from "drizzle-orm";

import { type Currency, ErrorCode, IdPrefix, MintRailError, NotFoundError, parseId, type Tx } from "@mintrail/shared";
import { type BlocklistKind, RiskEngine } from "@mintrail/conductor";
import { LedgerService } from "@mintrail/ledger";

import type { AppDeps } from "../deps.js";
import { clientIp } from "../http/middleware.js";
import { apiKeyOut, auditOut, blocklistOut, internalPaymentOut, internalStationOut, list, paymentOut, staffOut } from "../http/out.js";
import { type makeRoute, stationService } from "../http/route.js";
import { type KeyMode, type KycStatus, paymentEvents, payments, type StaffRole } from "../schema/index.js";
import { AuditService } from "../services/audit.js";
import { PaymentService, PaymentVelocity } from "../services/payments.js";
import { ROLE_PERMISSIONS, StaffContext, StaffService } from "../services/staff.js";
import * as S from "./schemas.js";

const perms = (role: string): string[] => [...ROLE_PERMISSIONS[role as StaffRole]].sort();

export function railyardRoutes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  const staffSvc = (tx: Tx) => new StaffService(tx, deps.settings, deps.clock);
  const audit = (tx: Tx, req: Parameters<typeof clientIp>[0]) => new AuditService(tx, clientIp(req));
  const sid = (v: string) => parseId(v, IdPrefix.STATION);

  // ---------------------------------------------------------------- auth & staff
  route("post", "/internal/v1/auth/login", { body: S.LoginIn }, async (c) => {
    let failure: unknown;
    const result = await deps.db.transaction(async (tx) => {
      try {
        const [user, token] = await staffSvc(tx).login(c.body.email, c.body.password, {
          ip: clientIp(c.req),
          userAgent: c.req.get("user-agent") ?? null,
        });
        await audit(tx, c.req).record(new StaffContext(user, ""), "staff.login", { targetType: "staff", targetId: user.id });
        return { user, token };
      } catch (e) {
        if (!(e instanceof MintRailError)) throw e;
        await audit(tx, c.req).record(null, "staff.login_failed", { actorEmail: c.body.email, details: { code: e.code } });
        failure = e;
        return null;
      }
    });
    if (failure || !result) throw failure;
    return {
      status: 200,
      body: {
        token: result.token,
        expires_in: deps.settings.staff_session_ttl_s,
        staff: staffOut(result.user),
        permissions: perms(result.user.role),
      },
    };
  });

  route("post", "/internal/v1/auth/logout", { staff: "any" }, async (c) => {
    await deps.db.transaction(async (tx) => {
      await staffSvc(tx).logout(c.staff.sessionId);
      await audit(tx, c.req).record(c.staff, "staff.logout", { targetType: "staff", targetId: c.staff.staff.id });
    });
    return { status: 204, body: undefined };
  });

  route("get", "/internal/v1/auth/me", { staff: "any" }, async (c) => ({
    status: 200,
    body: { staff: staffOut(c.staff.staff), permissions: perms(c.staff.staff.role) },
  }));

  route("get", "/internal/v1/staff", { staff: "staff:manage" }, async () => ({
    status: 200,
    body: list((await staffSvc(deps.db).listStaff()).map(staffOut), false),
  }));

  route("post", "/internal/v1/staff", { staff: "staff:manage", body: S.StaffCreateIn }, async (c) => {
    const user = await deps.db.transaction(async (tx) => {
      const u = await staffSvc(tx).createStaff({
        email: c.body.email,
        fullName: c.body.full_name,
        role: c.body.role,
        password: c.body.password,
      });
      await audit(tx, c.req).record(c.staff, "staff.create", { targetType: "staff", targetId: u.id, details: { role: u.role } });
      return u;
    });
    return { status: 201, body: staffOut(user) };
  });

  route("post", "/internal/v1/staff/:staff_id/disable", { staff: "staff:manage" }, async (c) => {
    const user = await deps.db.transaction(async (tx) => {
      const u = await staffSvc(tx).disable(c.params.staff_id!);
      await audit(tx, c.req).record(c.staff, "staff.disable", { targetType: "staff", targetId: u.id });
      return u;
    });
    return { status: 200, body: staffOut(user) };
  });

  route("get", "/internal/v1/audit_log", { staff: "audit:read", query: S.AuditQuery }, async (c) => {
    const [rows, more] = await new AuditService(deps.db).search({
      limit: c.query.limit,
      beforeId: c.query.starting_after == null ? null : BigInt(c.query.starting_after),
      targetId: c.query.target_id ?? null,
      staffId: c.query.staff_id ?? null,
    });
    return { status: 200, body: list(rows.map(auditOut), more) };
  });

  // ---------------------------------------------------------------- stations
  route("post", "/internal/v1/stations", { staff: "stations:write", body: S.StationCreateIn }, async (c) => {
    const [station, keyRow, key] = await deps.db.transaction(async (tx) => {
      const r = await stationService(deps, tx).createStation({
        legalName: c.body.legal_name,
        displayName: c.body.display_name,
        email: c.body.email,
        businessCategory: c.body.business_category,
        defaultCurrency: c.body.default_currency as Currency,
        settings: c.body.settings ? presentKeys(c.body.settings, c.req.mr.rawBody, "settings") : {},
      });
      await audit(tx, c.req).record(c.staff, "station.create", { targetType: "station", targetId: r[0].id });
      return r;
    });
    return { status: 201, body: { station: internalStationOut(station), test_api_key: { ...apiKeyOut(keyRow), secret: key.secret } } };
  });

  route("get", "/internal/v1/stations", { staff: "stations:read", query: S.StationListQuery }, async (c) => {
    if (c.query.starting_after != null) parseId(c.query.starting_after, IdPrefix.STATION, "starting_after");
    const [rows, more] = await stationService(deps, deps.db).listStations({
      limit: c.query.limit,
      startingAfter: c.query.starting_after ?? null,
      kycStatus: (c.query.kyc_status ?? null) as KycStatus | null,
      query: c.query.q ?? null,
    });
    return { status: 200, body: list(rows.map(internalStationOut), more) };
  });

  route("get", "/internal/v1/stations/:station_id", { staff: "stations:read" }, async (c) => ({
    status: 200,
    body: internalStationOut(await stationService(deps, deps.db).get(sid(c.params.station_id!))),
  }));

  route("patch", "/internal/v1/stations/:station_id/settings", { staff: "stations:write", body: S.StaffSettingsIn }, async (c) => {
    const changes = presentKeys(c.body, c.req.mr.rawBody);
    const station = await deps.db.transaction(async (tx) => {
      const [s, before] = await stationService(deps, tx).updateSettings(sid(c.params.station_id!), changes, true);
      await audit(tx, c.req).record(c.staff, "station.settings_update", {
        targetType: "station",
        targetId: s.id,
        details: { before, after: changes },
      });
      return s;
    });
    return { status: 200, body: internalStationOut(station) };
  });

  const stationAction = (
    path: string,
    perm: "kyc:review" | "stations:suspend",
    action: string,
    body: typeof S.ReasonIn | undefined,
    run: (
      svc: ReturnType<typeof stationService>,
      id: string,
      staff: StaffContext,
      reason: string | undefined,
    ) => ReturnType<ReturnType<typeof stationService>["get"]>,
  ) =>
    route("post", `/internal/v1/stations/:station_id/${path}`, { staff: perm, body }, async (c) => {
      const reason = (c.body as { reason?: string } | undefined)?.reason;
      const station = await deps.db.transaction(async (tx) => {
        const s = await run(stationService(deps, tx), sid(c.params.station_id!), c.staff, reason);
        await audit(tx, c.req).record(c.staff, action, {
          targetType: "station",
          targetId: s.id,
          ...(reason !== undefined ? { details: { reason } } : {}),
        });
        return s;
      });
      return { status: 200, body: internalStationOut(station) };
    });

  stationAction("kyc/verify", "kyc:review", "station.kyc_verify", undefined, (svc, id, staff) => svc.kycVerify(id, staff.staff.id));
  stationAction("kyc/reject", "kyc:review", "station.kyc_reject", S.ReasonIn, (svc, id, staff, reason) =>
    svc.kycReject(id, staff.staff.id, reason!),
  );
  stationAction("kyc/reopen", "kyc:review", "station.kyc_reopen", undefined, (svc, id) => svc.kycReopen(id));
  stationAction("suspend", "stations:suspend", "station.suspend", S.ReasonIn, (svc, id, _s, reason) => svc.suspend(id, reason!));
  stationAction("reactivate", "stations:suspend", "station.reactivate", undefined, (svc, id) => svc.reactivate(id));

  route("get", "/internal/v1/stations/:station_id/api_keys", { staff: "stations:read" }, async (c) => ({
    status: 200,
    body: list((await stationService(deps, deps.db).listKeys(sid(c.params.station_id!))).map(apiKeyOut), false),
  }));

  route("post", "/internal/v1/stations/:station_id/api_keys", { staff: "api_keys:manage", body: S.ApiKeyCreateIn }, async (c) => {
    const [row, generated] = await deps.db.transaction(async (tx) => {
      const r = await stationService(deps, tx).issueKey(
        sid(c.params.station_id!),
        c.body.mode as KeyMode,
        c.body.scopes ?? null,
        c.body.label ?? null,
      );
      await audit(tx, c.req).record(c.staff, "api_key.create", {
        targetType: "api_key",
        targetId: r[0].id,
        details: { station_id: r[0].stationId, mode: r[0].mode, scopes: r[0].scopes },
      });
      return r;
    });
    return { status: 201, body: { ...apiKeyOut(row), secret: generated.secret } };
  });

  route("post", "/internal/v1/api_keys/:key_id/revoke", { staff: "api_keys:manage" }, async (c) => {
    const key = await deps.db.transaction(async (tx) => {
      const k = await stationService(deps, tx).revokeKey(parseId(c.params.key_id!, IdPrefix.API_KEY));
      await audit(tx, c.req).record(c.staff, "api_key.revoke", {
        targetType: "api_key",
        targetId: k.id,
        details: { station_id: k.stationId },
      });
      return k;
    });
    return { status: 200, body: apiKeyOut(key) };
  });

  // ---------------------------------------------------------------- payments & risk
  const loadInternal = async (tx: Tx, id: string) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, id));
    if (!p) throw new NotFoundError(`payment ${id} not found`, { code: ErrorCode.PAYMENT_NOT_FOUND });
    const events = await tx.select().from(paymentEvents).where(eq(paymentEvents.paymentId, id)).orderBy(asc(paymentEvents.id));
    return internalPaymentOut(p, events);
  };

  route("get", "/internal/v1/payments/review_queue", { staff: "risk:review", query: S.ReviewQueueQuery }, async (c) => {
    const rows = await deps.db
      .select()
      .from(payments)
      .where(eq(payments.riskReviewStatus, "pending"))
      .orderBy(asc(payments.id))
      .limit(c.query.limit + 1);
    return { status: 200, body: list(rows.slice(0, c.query.limit).map(paymentOut), rows.length > c.query.limit) };
  });

  route("get", "/internal/v1/payments/:payment_id", { staff: "payments:read" }, async (c) => ({
    status: 200,
    body: await loadInternal(deps.db, parseId(c.params.payment_id!, IdPrefix.PAYMENT)),
  }));

  route("post", "/internal/v1/payments/:payment_id/risk_review", { staff: "risk:review", body: S.RiskReviewIn }, async (c) => {
    const id = await deps.db.transaction(async (tx) => {
      const p = await new PaymentService(tx, deps.settings, deps.junction, deps.clock).review(
        parseId(c.params.payment_id!, IdPrefix.PAYMENT),
        c.body.action === "approve",
        c.staff.staff.id,
      );
      await audit(tx, c.req).record(c.staff, `payment.risk_${c.body.action}`, {
        targetType: "payment",
        targetId: p.id,
        details: { note: c.body.note },
      });
      return p.id;
    });
    return { status: 200, body: await loadInternal(deps.db, id) };
  });

  const engine = (tx: Tx) => new RiskEngine(tx, new PaymentVelocity(tx), deps.clock);

  route("get", "/internal/v1/risk/blocklist", { staff: "risk_rules:manage" }, async () => ({
    status: 200,
    body: list((await engine(deps.db).listBlocklist()).map(blocklistOut), false),
  }));

  route("post", "/internal/v1/risk/blocklist", { staff: "risk_rules:manage", body: S.BlocklistIn }, async (c) => {
    const entry = await deps.db.transaction(async (tx) => {
      const e = await engine(tx).addToBlocklist(c.body.kind as BlocklistKind, c.body.value, {
        reason: c.body.reason,
        staffId: c.staff.staff.id,
      });
      await audit(tx, c.req).record(c.staff, "risk.blocklist_add", {
        targetType: "blocklist_entry",
        targetId: e.id,
        details: { kind: e.kind, value: e.value, reason: c.body.reason },
      });
      return e;
    });
    return { status: 201, body: blocklistOut(entry) };
  });

  route("post", "/internal/v1/risk/blocklist/:entry_id/deactivate", { staff: "risk_rules:manage" }, async (c) => {
    const entry = await deps.db.transaction(async (tx) => {
      const e = await engine(tx).removeFromBlocklist(parseId(c.params.entry_id!, IdPrefix.BLOCKLIST_ENTRY));
      await audit(tx, c.req).record(c.staff, "risk.blocklist_remove", { targetType: "blocklist_entry", targetId: e.id });
      return e;
    });
    return { status: 200, body: blocklistOut(entry) };
  });

  // ---------------------------------------------------------------- ledger
  route("get", "/internal/v1/ledger/trial_balance", { staff: "ledger:read", query: S.TrialBalanceQuery }, async (c) => {
    const tb = await new LedgerService(deps.db).trialBalance(c.query.currency as Currency, c.query.livemode);
    return {
      status: 200,
      body: {
        object: "trial_balance",
        currency: c.query.currency,
        livemode: c.query.livemode,
        debits: tb.debits.amount,
        credits: tb.credits.amount,
        balanced: tb.isBalanced,
      },
    };
  });

  route("get", "/internal/v1/ledger/reconcile", { staff: "ledger:read" }, async () => {
    const found = await new LedgerService(deps.db).reconcile();
    return { status: 200, body: { object: "ledger_reconciliation", ok: found.length === 0, discrepancies: found } };
  });
}

/** Pydantic ``model_dump(exclude_unset=True)``: only keys the client actually sent. */
function presentKeys(validated: Record<string, unknown>, raw: Buffer, nested?: string): Record<string, unknown> {
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const sent = (nested ? parsed[nested] : parsed) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(validated)
      .filter((k) => k in sent)
      .map((k) => [k, validated[k]]),
  );
}
