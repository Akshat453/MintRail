/** Ported from api/tests/test_payments_integration.py: orders, methods, Junction scenarios, capture, callbacks, risk. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { jobs, signatures, stringifyJson } from "@mintrail/shared";

import { junctionAuthorizations } from "../../junction/src/schema.js";
import type { Merchant } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";
import { eq, and, count } from "drizzle-orm";

const { h, db } = useHarness();
const CARD = (number: string) => ({ card: { number, expiry_month: 1, expiry_year: 2031, cvv: "111" } });
const bankStatus = async (paymentId: string) =>
  (
    await db()
      .select({ s: junctionAuthorizations.status })
      .from(junctionAuthorizations)
      .where(eq(junctionAuthorizations.paymentId, paymentId))
  )[0]!.s;
const postCallback = (event: Record<string, unknown>, opts: { secret?: string; ts?: number } = {}) => {
  const body = stringifyJson(event);
  const sig = signatures.header(
    Buffer.from(opts.secret ?? h().settings.junction_callback_secret),
    opts.ts ?? Math.floor(Date.now() / 1000),
    body,
  );
  return h().request("POST", "/internal/junction/v1/callbacks", { raw: body, headers: { "Junction-Signature": sig } });
};

describe("orders", () => {
  test("create, get, list", async () => {
    const m = await h().merchant();
    const o = await h().order(m, 2_500n, { receipt: "rcpt_1", notes: { customer: "C-17" } });
    expect(o.id).toMatch(/^ord_/);
    expect([o.status, o.amount_paid, o.attempts]).toEqual(["created", 0n, 0n]);
    expect((await h().call(m, "GET", `/v1/orders/${o.id}`)).body).toEqual(o);
    const o2 = await h().order(m, 3_000n);
    const page = (await h().call(m, "GET", "/v1/orders?limit=1")).body;
    expect([page.data.map((x: { id: string }) => x.id), page.has_more]).toEqual([[o2.id], true]);
    expect((await h().call(m, "GET", `/v1/orders?starting_after=${o2.id}`)).body.data.map((x: { id: string }) => x.id)).toEqual([o.id]);
  });

  test.each([
    [{ amount: 99 }, 422],
    [{ amount: 100_000_000_001 }, 422],
    [{ amount: 1000, currency: "EUR" }, 422],
    [{ amount: "1000" }, 422],
    [{ amount: 10.5 }, 422],
    [{ amount: 1000, receipt: "x".repeat(41) }, 422],
    [{ amount: 1000, notes: { k: "v".repeat(300) } }, 400],
  ])("validation %j → %s", async (body, status) => {
    const m = await h().merchant();
    expect((await h().call(m, "POST", "/v1/orders", body)).status).toBe(status);
  });

  test("isolation between stations and modes", async () => {
    const a = await h().merchant();
    const b = await h().merchant();
    const o = await h().order(a);
    expect((await h().call(b, "GET", `/v1/orders/${o.id}`)).body.error.code).toBe("MR_ORDER_NOT_FOUND");
    const live = await h().liveMerchant();
    const k = (await h().staff("POST", `/internal/v1/stations/${live.stationId}/api_keys`, {})).body;
    const testOrder = await h().order({ stationId: live.stationId, keyId: k.id, secret: k.secret });
    expect((await h().call(live, "GET", `/v1/orders/${testOrder.id}`, undefined, { signed: true })).status).toBe(404);
  });
});

describe("methods", () => {
  test("upi", async () => {
    const p = await h().paid(await h().merchant(), "upi", { details: { upi: { vpa: "asha@okaxis" } }, scenario: "success" });
    expect([p.status, p.vpa]).toEqual(["captured", "asha@okaxis"]);
  });
  test("card", async () => {
    const p = await h().paid(await h().merchant(), "card");
    expect(p.status).toBe("captured");
    expect(p.card).toEqual({ network: "visa", last4: "1111", bin: "411111", expiry_month: 12n, expiry_year: 2030n });
    expect([p.fee, p.tax]).toEqual([998n, 180n]);
  });
  test("netbanking", async () => {
    const p = await h().paid(await h().merchant(), "netbanking");
    expect([p.status, p.bank_code]).toEqual(["captured", "MRTEST"]);
  });
  test("USD card", async () => {
    const m = await h().merchant();
    const o = (await h().call(m, "POST", "/v1/orders", { amount: 10_000, currency: "USD" })).body;
    const r = await h().pay(m, o.id, "card");
    await h().drain();
    const p = await h().payment(m, r.body.id);
    expect([p.status, p.currency, p.fee]).toEqual(["captured", "USD", 300n]);
    expect((await h().call(m, "GET", "/v1/balance")).body.balances).toContainEqual({ currency: "USD", balance: 10_000n - 300n - 54n });
  });
  test("USD requires card", async () => {
    const m = await h().merchant();
    const o = (await h().call(m, "POST", "/v1/orders", { amount: 10_000, currency: "USD" })).body;
    expect((await h().pay(m, o.id, "upi")).body.error.code).toBe("MR_INVALID_PAYMENT_METHOD");
  });
  test("method details required", async () => {
    const m = await h().merchant();
    const o = await h().order(m);
    const r = await h().call(m, "POST", "/v1/payments", { order_id: o.id, method: "card" });
    expect([r.body.error.code, r.body.error.param]).toEqual(["MR_INVALID_PAYMENT_METHOD", "card"]);
  });
  test("never returns the PAN", async () => {
    const m = await h().merchant();
    const r = await h().pay(m, (await h().order(m)).id, "card");
    expect(r.text).not.toContain("4111111111111111");
    await h().drain();
    expect(JSON.stringify(await h().internalPayment(r.body.id), (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(
      "4111111111111111",
    );
  });
});

describe("declines", () => {
  test.each([
    ["upi", "decline:upi_collect_expired", "upi_collect_expired"],
    ["card", "decline:insufficient_funds", "insufficient_funds"],
    ["card", "decline:do_not_honor", "do_not_honor"],
    ["netbanking", "decline:bank_unavailable", "bank_unavailable"],
  ] as const)("%s %s", async (method, scenario, code) => {
    const p = await h().paid(await h().merchant(), method, { scenario });
    expect([p.status, p.error_code]).toEqual(["failed", code]);
    expect(p.error_description).toBeTruthy();
  });
  test.each([
    ["upi", { upi: { vpa: "failure@mintrail" } }, "upi_collect_declined"],
    ["card", CARD("4000000000000002"), "card_declined"],
    ["card", CARD("4000000000009995"), "insufficient_funds"],
    ["netbanking", { netbanking: { bank_code: "MRFAIL" } }, "netbanking_cancelled"],
  ] as const)("magic instrument %s → %s", async (method, details, code) => {
    const p = await h().paid(await h().merchant(), method, { details });
    expect([p.status, p.error_code]).toEqual(["failed", code]);
  });
  test("retry after failure, then success", async () => {
    const m = await h().merchant();
    const o = await h().order(m);
    const first = (await h().pay(m, o.id, "upi", { scenario: "decline:upi_collect_declined" })).body;
    await h().drain();
    expect((await h().payment(m, first.id)).status).toBe("failed");
    const second = (await h().pay(m, o.id)).body;
    await h().drain();
    expect((await h().payment(m, second.id)).status).toBe("captured");
    const order = (await h().call(m, "GET", `/v1/orders/${o.id}`)).body;
    expect([order.status, order.attempts]).toEqual(["paid", 2n]);
    expect((await h().call(m, "GET", `/v1/orders/${o.id}/payments`)).body.data.map((p: { status: string }) => p.status)).toEqual([
      "captured",
      "failed",
    ]);
    expect((await h().call(m, "GET", "/v1/payments?status=failed")).body.data.map((p: { id: string }) => p.id)).toEqual([first.id]);
  });
});

describe("order rules", () => {
  test("one payment in flight", async () => {
    const m = await h().merchant();
    const o = await h().order(m);
    expect((await h().pay(m, o.id)).status).toBe(201);
    expect((await h().pay(m, o.id)).body.error.code).toBe("MR_PAYMENT_IN_PROGRESS");
  });
  test("paid order", async () => {
    const m = await h().merchant();
    const o = await h().order(m);
    await h().pay(m, o.id);
    await h().drain();
    expect((await h().pay(m, o.id)).body.error.code).toBe("MR_ORDER_ALREADY_PAID");
  });
});

describe("Junction scenarios", () => {
  test("timeout fails after the deadline and voids at the bank", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "upi", { scenario: "timeout" })).body.id;
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("pending");
    await h().releaseJobs("payments.status_check");
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("pending");
    await h().agePayment(id, h().settings.payment_timeout_s + 1);
    await h().releaseJobs("payments.status_check");
    await h().drain();
    const p = await h().payment(m, id);
    expect([p.status, p.error_code]).toEqual(["failed", "gateway_timeout"]);
    expect(await bankStatus(id)).toBe("voided");
  });
  test("timeout via magic VPA", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "upi", { details: { upi: { vpa: "timeout@mintrail" } } })).body.id;
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("pending");
  });
  test("delayed", async () => expect((await h().paid(await h().merchant(), "upi", { scenario: "delayed:45" })).status).toBe("captured"));
  test("duplicate callbacks apply once", async () => {
    const p = await h().paid(await h().merchant(), "card", { scenario: "duplicate_callbacks" });
    expect(p.status).toBe("captured");
    const events = (await h().internalPayment(p.id)).events;
    expect(events.filter((e: { type: string }) => e.type === "junction.authorization.succeeded")).toHaveLength(1);
    const [delivered] = await db()
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.kind, "junction.deliver_callback"), eq(jobs.status, "succeeded")));
    expect(delivered!.n).toBe(3);
  });
  test("out-of-order callbacks", async () => {
    const p = await h().paid(await h().merchant(), "upi", { scenario: "out_of_order" });
    expect(p.status).toBe("captured");
    const junction = (await h().internalPayment(p.id)).events.filter((e: { type: string }) => e.type.startsWith("junction."));
    expect(junction.map((e: { sequence: bigint; applied: boolean }) => [e.sequence, e.applied])).toEqual([
      [2n, true],
      [1n, false],
    ]);
    expect(junction[1].note).toMatch(/^stale/);
  });
  test("flaky bank is retried", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "upi", { scenario: "flaky" })).body.id;
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("created");
    await h().releaseJobs("payments.submit");
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("captured");
  });
  test("unknown scenario rejected by the bank", async () => {
    const p = await h().paid(await h().merchant(), "upi", { scenario: "meteor_strike" });
    expect([p.status, p.error_code]).toEqual(["failed", "gateway_rejected"]);
  });
  test.each(["Bad Scenario!", "x".repeat(80)])("malformed scenario %j", async (s) => {
    const m = await h().merchant();
    expect([400, 422]).toContain((await h().pay(m, (await h().order(m)).id, "upi", { scenario: s })).status);
  });
  test("scenarios forbidden in live mode", async () => {
    const live = await h().liveMerchant();
    const o = (await h().call(live, "POST", "/v1/orders", { amount: 1000 }, { signed: true })).body;
    const r = await h().call(
      live,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "upi", upi: { vpa: "asha@okaxis" } },
      { signed: true, headers: { "MintRail-Test-Scenario": "success" } },
    );
    expect(r.body.error.code).toBe("MR_SCENARIO_NOT_ALLOWED");
  });
  test("late authorization is voided", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "upi", { scenario: "timeout" })).body.id;
    await h().drain();
    await h().agePayment(id, h().settings.payment_timeout_s + 1);
    await h().releaseJobs("payments.status_check");
    await h().drain();
    const ref = (await h().internalPayment(id)).junction_ref;
    const r = await postCallback({ id: `jev_${ref}_2`, type: "authorization.succeeded", sequence: 2, ref, payment_id: id });
    expect(r.body.outcome).toBe("ignored");
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("failed");
    expect((await h().internalPayment(id)).events.map((e: { type: string }) => e.type)).toContain("authorization.voided");
  });
});

describe("manual capture", () => {
  test("flow", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "card", { extra: { capture: "manual" } })).body.id;
    await h().drain();
    const p = await h().payment(m, id);
    expect([p.status, p.capture_mode]).toEqual(["authorized", "manual"]);
    expect((await h().call(m, "GET", "/v1/balance")).body.balances).toEqual([{ currency: "INR", balance: 0n }]);
    expect((await h().call(m, "POST", `/v1/payments/${id}/capture`, { amount: 100 })).status).toBe(422);
    const r = await h().call(m, "POST", `/v1/payments/${id}/capture`, {});
    expect([r.status, r.body.status]).toEqual([200, "captured"]);
    expect((await h().call(m, "POST", `/v1/payments/${id}/capture`, {})).body.status).toBe("captured");
    expect(await bankStatus(id)).toBe("captured");
  });
  test("station default manual", async () =>
    expect((await h().paid(await h().merchant({ settings: { auto_capture: false } }), "card")).status).toBe("authorized"));
  test("cannot capture failed", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card", { scenario: "decline:card_declined" });
    expect((await h().call(m, "POST", `/v1/payments/${p.id}/capture`, {})).body.error.code).toBe("MR_PAYMENT_NOT_CAPTURABLE");
  });
  test("authorization expiry", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "card", { extra: { capture: "manual" } })).body.id;
    await h().drain();
    await h().releaseJobs("payments.expire_authorization");
    await h().drain();
    const p = await h().payment(m, id);
    expect([p.status, p.error_code]).toEqual(["failed", "authorization_expired"]);
    expect(await bankStatus(id)).toBe("voided");
  });
  test("other station cannot read or capture", async () => {
    const a = await h().merchant();
    const b = await h().merchant();
    const p = await h().paid(a, "card", { extra: { capture: "manual" } });
    expect((await h().call(b, "GET", `/v1/payments/${p.id}`)).body.error.code).toBe("MR_PAYMENT_NOT_FOUND");
    expect((await h().call(b, "POST", `/v1/payments/${p.id}/capture`, {})).status).toBe(404);
  });
  test("bank error during capture → 502, idempotency key released, retry succeeds", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "card", { extra: { capture: "manual" } })).body.id;
    await h().drain();
    // Make the bank reject the capture: point the payment at a reference Junction doesn't know.
    const ref = (await h().internalPayment(id)).junction_ref as string;
    await db().execute(sql`UPDATE payments SET junction_ref = 'JN000000000000' WHERE id = ${id}`);
    const r = await h().call(m, "POST", `/v1/payments/${id}/capture`, {}, { idempotencyKey: "cap-1" });
    await db().execute(sql`UPDATE payments SET junction_ref = ${ref} WHERE id = ${id}`);
    expect([r.status, r.body.error.code]).toEqual([502, "MR_GATEWAY_ERROR"]);
    const retry = await h().call(m, "POST", `/v1/payments/${id}/capture`, {}, { idempotencyKey: "cap-1" });
    expect([retry.status, retry.body.status, retry.headers["idempotent-replayed"]]).toEqual([200, "captured", undefined]);
  });
});

describe("callback security", () => {
  test("missing signature", async () => {
    expect((await h().request("POST", "/internal/junction/v1/callbacks", { raw: "{}" })).body.error.code).toBe("MR_SIGNATURE_REQUIRED");
  });
  test("forged signature", async () =>
    expect((await postCallback({ id: "x" }, { secret: "not-the-secret" })).body.error.code).toBe("MR_INVALID_SIGNATURE"));
  test("replayed old callback", async () =>
    expect((await postCallback({ id: "x" }, { ts: Math.floor(Date.now() / 1000) - 3600 })).body.error.code).toBe("MR_INVALID_SIGNATURE"));
  test("malformed and unknown", async () => {
    expect((await postCallback({ id: "x" })).status).toBe(400);
    const r = await postCallback({
      id: "jev_x_1",
      type: "authorization.succeeded",
      sequence: 1,
      ref: "JN000000000000",
      payment_id: "pay_00000000000000000000000000",
    });
    expect(r.body.error.code).toBe("MR_PAYMENT_NOT_FOUND");
  });
  test("bank failure after capture is ignored", async () => {
    const m = await h().merchant();
    const p = await h().paid(m);
    const ref = (await h().internalPayment(p.id)).junction_ref;
    const r = await postCallback({
      id: `jev_${ref}_9`,
      type: "authorization.failed",
      sequence: 9,
      ref,
      payment_id: p.id,
      decline_code: "card_declined",
    });
    expect(r.body.outcome).toBe("ignored");
    expect((await h().payment(m, p.id)).status).toBe("captured");
  });
});

describe("risk", () => {
  test("blocklisted VPA is blocked without reaching the bank", async () => {
    const add = await h().staff(
      "POST",
      "/internal/v1/risk/blocklist",
      { kind: "vpa", value: "Mule@OkBank", reason: "money mule" },
      "security",
    );
    expect(add.status).toBe(201);
    const m = await h().merchant();
    const p = (await h().pay(m, (await h().order(m)).id, "upi", { details: { upi: { vpa: "mule@okbank" } } })).body;
    expect([p.status, p.error_code, p.risk.decision, p.risk.reasons[0].rule]).toEqual(["failed", "risk_blocked", "block", "blocked_vpa"]);
    expect(await h().drain()).toBe(0); // nothing was sent to Junction
    expect(
      (await h().staff("POST", "/internal/v1/risk/blocklist", { kind: "vpa", value: "mule@okbank", reason: "again" }, "security")).status,
    ).toBe(409);
    await h().staff("POST", `/internal/v1/risk/blocklist/${add.body.id}/deactivate`, undefined, "security");
    const p2 = (await h().pay(m, (await h().order(m)).id, "upi", { details: { upi: { vpa: "mule@okbank" } } })).body;
    expect(p2.risk.decision).toBe("allow");
  });
  test("blocked BIN", async () => {
    await h().staff("POST", "/internal/v1/risk/blocklist", { kind: "card_bin", value: "411111", reason: "BIN attack" });
    const m = await h().merchant();
    expect((await h().pay(m, (await h().order(m)).id, "card")).body.risk.reasons[0].rule).toBe("blocked_bin");
  });
  test("UPI limit", async () => {
    const m = await h().merchant();
    const p = (await h().pay(m, (await h().order(m, 1_00_000_01n)).id)).body;
    expect([p.error_code, p.risk.reasons[0].rule]).toEqual(["risk_blocked", "amount_over_method_limit"]);
  });
  test("station limit", async () => {
    const m = await h().merchant({ settings: { max_payment_amount: 10_000 } });
    expect((await h().pay(m, (await h().order(m, 10_001n)).id)).body.risk.reasons[0].rule).toBe("amount_over_station_limit");
  });
  test("high value: review, then approve", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m, 2_50_000_00n)).id, "card")).body.id;
    await h().drain();
    const p = await h().payment(m, id);
    expect([p.status, p.risk.decision, p.risk.review_status]).toEqual(["authorized", "review", "pending"]);
    expect(
      (await h().staff("GET", "/internal/v1/payments/review_queue", undefined, "ops")).body.data.map((x: { id: string }) => x.id),
    ).toEqual([id]);
    expect((await h().call(m, "POST", `/v1/payments/${id}/capture`, {})).body.error.code).toBe("MR_PAYMENT_NOT_CAPTURABLE");
    const r = await h().staff(
      "POST",
      `/internal/v1/payments/${id}/risk_review`,
      { action: "approve", note: "known corporate buyer" },
      "ops",
    );
    expect(r.body.risk.review_status).toBe("approved");
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("captured");
    expect((await h().staff("POST", `/internal/v1/payments/${id}/risk_review`, { action: "reject" }, "ops")).status).toBe(409);
  });
  test("review reject voids", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m, 2_50_000_00n)).id, "card")).body.id;
    await h().drain();
    await h().staff("POST", `/internal/v1/payments/${id}/risk_review`, { action: "reject" });
    await h().drain();
    const p = await h().payment(m, id);
    expect([p.status, p.error_code]).toEqual(["failed", "risk_rejected"]);
    expect(await bankStatus(id)).toBe("voided");
  });
  test("velocity", async () => {
    const m = await h().merchant();
    const decisions = [];
    for (let i = 0; i < 5; i++)
      decisions.push((await h().pay(m, (await h().order(m)).id, "upi", { details: { upi: { vpa: "rapid@okbank" } } })).body.risk.decision);
    expect(decisions).toEqual(["allow", "allow", "allow", "allow", "review"]);
  });
  test("bad blocklist values", async () => {
    for (const body of [
      { kind: "card_bin", value: "41x", reason: "bad" },
      { kind: "vpa", value: "nope", reason: "bad" },
    ]) {
      expect((await h().staff("POST", "/internal/v1/risk/blocklist", body)).status).toBe(400);
    }
  });
});

test("ledger reconciles after mixed traffic", async () => {
  const m: Merchant = await h().merchant();
  for (const scenario of ["success", "decline:card_declined", "duplicate_callbacks", "out_of_order"]) {
    await h().paid(m, scenario.includes("card") ? "card" : "upi", { scenario });
  }
  expect((await h().staff("GET", "/internal/v1/ledger/trial_balance")).body.balanced).toBe(true);
  expect((await h().staff("GET", "/internal/v1/ledger/reconcile")).body.ok).toBe(true);
  const res = await db().execute<{ n: bigint }>(sql`SELECT count(*) AS n FROM ledger_transactions WHERE reference_type='payment'`);
  expect(res.rows[0]!.n).toBe(3n);
});
