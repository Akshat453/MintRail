/** Public, API-key-authenticated endpoints (``/v1``). */
import { type Currency, ErrorCode, IdPrefix, InvalidRequestError, parseId, type Tx } from "@mintrail/shared";
import { LedgerService } from "@mintrail/ledger";

import type { AppDeps } from "../deps.js";
import { list, orderOut, paymentOut, stationOut } from "../http/out.js";
import { type makeRoute, stationService } from "../http/route.js";
import { type Instrument, parseCard, parseNetbanking, parseUpi } from "../payment-methods.js";
import type { CaptureMode, PaymentStatus } from "../schema/index.js";
import { PaymentService } from "../services/payments.js";
import * as S from "./schemas.js";

export const SCENARIO_HEADER = "MintRail-Test-Scenario";

export function v1Routes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  const payments = (tx: Tx) => new PaymentService(tx, deps.settings, deps.junction, deps.clock);

  // ---------------------------------------------------------------- station
  route("get", "/v1/station", { merchant: { scope: "station:read" } }, async (c) => ({ status: 200, body: stationOut(c.auth.station) }));

  route("patch", "/v1/station/settings", { merchant: { scope: "station:write" }, body: S.MerchantSettingsIn }, async (c) => {
    const station = await deps.db.transaction(
      async (tx) => (await stationService(deps, tx).updateSettings(c.auth.station.id, c.body, false))[0],
    );
    return { status: 200, body: stationOut(station) };
  });

  route("get", "/v1/balance", { merchant: { scope: "balance:read" }, query: S.BalanceQuery }, async (c) => {
    const currency = c.query.currency ?? null;
    const totals = new Map<string, bigint>();
    const balances = await new LedgerService(deps.db).balancesForOwner(c.auth.station.id, c.auth.livemode);
    for (const bal of balances) {
      const [, , , kind, cur] = bal.code.split(":");
      if (kind !== "merchant_balance" || (currency && cur !== currency)) continue;
      totals.set(cur!, bal.balance.amount);
    }
    if (currency && !totals.has(currency)) totals.set(currency, 0n);
    return {
      status: 200,
      body: {
        object: "balance",
        livemode: c.auth.livemode,
        balances: [...totals].sort(([a], [b]) => (a < b ? -1 : 1)).map(([cur, b]) => ({ currency: cur, balance: b })),
      },
    };
  });

  // ---------------------------------------------------------------- orders
  route("post", "/v1/orders", { merchant: { scope: "orders:write" }, idempotent: true, body: S.OrderCreateIn }, async (c) =>
    c.idem.run(async (tx) => {
      const order = await payments(tx).createOrder(c.auth, {
        amount: c.body.amount,
        currency: c.body.currency as Currency,
        receipt: c.body.receipt ?? null,
        notes: (c.body.notes as Record<string, unknown> | null | undefined) ?? null,
      });
      return { status: 201, body: orderOut(order) };
    }),
  );

  route("get", "/v1/orders", { merchant: { scope: "orders:read" }, query: S.ListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.ORDER, "starting_after");
    const [rows, more] = await payments(deps.db).listOrders(c.auth, { limit: c.query.limit, startingAfter: c.query.starting_after });
    return { status: 200, body: list(rows.map(orderOut), more) };
  });

  route("get", "/v1/orders/:order_id", { merchant: { scope: "orders:read" } }, async (c) => ({
    status: 200,
    body: orderOut(await payments(deps.db).getOrder(c.auth, parseId(c.params.order_id!, IdPrefix.ORDER))),
  }));

  route("get", "/v1/orders/:order_id/payments", { merchant: { scope: "orders:read" } }, async (c) => {
    const svc = payments(deps.db);
    const order = await svc.getOrder(c.auth, parseId(c.params.order_id!, IdPrefix.ORDER));
    const [rows, more] = await svc.listPayments(c.auth, { limit: 100, orderId: order.id });
    return { status: 200, body: list(rows.map(paymentOut), more) };
  });

  // ---------------------------------------------------------------- payments
  const instrument = (body: typeof S.PaymentCreateIn._output, livemode: boolean): Instrument => {
    const pepper = deps.settings.api_key_pepper;
    const details = { card: body.card, upi: body.upi, netbanking: body.netbanking }[body.method];
    if (details == null) {
      throw new InvalidRequestError(`method '${body.method}' requires a '${body.method}' object`, {
        code: ErrorCode.INVALID_PAYMENT_METHOD,
        param: body.method,
      });
    }
    if (body.method === "card" && body.card) {
      const k = body.card;
      return parseCard(k.number, k.expiry_month, k.expiry_year, k.cvv, { pepper, today: deps.clock.now() });
    }
    if (body.method === "upi" && body.upi) return parseUpi(body.upi.vpa, { pepper });
    return parseNetbanking(body.netbanking!.bank_code, { pepper, livemode });
  };

  route("post", "/v1/payments", { merchant: { scope: "payments:write" }, idempotent: true, body: S.PaymentCreateIn }, async (c) => {
    const scenario = c.req.get(SCENARIO_HEADER);
    return c.idem.run(async (tx) => {
      const payment = await payments(tx).createPayment(c.auth, {
        orderId: parseId(c.body.order_id, IdPrefix.ORDER, "order_id"),
        instrument: instrument(c.body, c.auth.livemode),
        capture: (c.body.capture ?? null) as CaptureMode | null,
        customerEmail: c.body.email ?? null,
        scenario: scenario === undefined ? null : scenario,
      });
      return { status: 201, body: paymentOut(payment) };
    });
  });

  route("get", "/v1/payments", { merchant: { scope: "payments:read" }, query: S.PaymentListQuery }, async (c) => {
    if (c.query.starting_after) parseId(c.query.starting_after, IdPrefix.PAYMENT, "starting_after");
    const [rows, more] = await payments(deps.db).listPayments(c.auth, {
      limit: c.query.limit,
      startingAfter: c.query.starting_after,
      status: (c.query.status ?? null) as PaymentStatus | null,
    });
    return { status: 200, body: list(rows.map(paymentOut), more) };
  });

  route("get", "/v1/payments/:payment_id", { merchant: { scope: "payments:read" } }, async (c) => ({
    status: 200,
    body: paymentOut(await payments(deps.db).getPayment(c.auth, parseId(c.params.payment_id!, IdPrefix.PAYMENT))),
  }));

  route(
    "post",
    "/v1/payments/:payment_id/capture",
    { merchant: { scope: "payments:write" }, idempotent: true, body: S.CaptureIn },
    async (c) =>
      c.idem.run(async (tx) => {
        const svc = payments(tx);
        const p = await svc.getPayment(c.auth, parseId(c.params.payment_id!, IdPrefix.PAYMENT));
        return { status: 200, body: paymentOut(await svc.capture(p.id, c.body.amount ?? null)) };
      }),
  );
}
