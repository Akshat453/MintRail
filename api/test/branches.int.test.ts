/** Edge branches of the services that the HTTP suites don't naturally reach. */
import { sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";

import { FrozenClock, log } from "@mintrail/shared";

import { JunctionClient, JunctionRejectedError, JunctionUnavailableError } from "../src/junction-client.js";
import { PaymentService } from "../src/services/payments.js";
import { StaffService } from "../src/services/staff.js";
import { STAFF_PASSWORD } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();

describe("Junction client", () => {
  test("unreachable bank → JunctionUnavailableError", async () => {
    const c = new JunctionClient("http://127.0.0.1:1", "k", 500);
    await expect(c.find("pay_x")).rejects.toThrow(JunctionUnavailableError);
  });
  test("4xx with non-JSON body → JunctionRejectedError carrying the text", async () => {
    const c = new JunctionClient("http://x", "k", 500, (async () => new Response("teapot", { status: 418 })) as typeof fetch);
    await expect(c.find("pay_x")).rejects.toMatchObject({ status: 418, code: "unknown", detail: "teapot" });
    await expect(c.void("JN1")).rejects.toBeInstanceOf(JunctionRejectedError);
    await expect(c.capture("JN1", 1n)).rejects.toBeInstanceOf(JunctionRejectedError);
  });
});

describe("payments state machine edges", () => {
  test("pending event for a non-created payment and unknown event types are ignored; bank failure after authorization is a Derailment", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const m = await h().merchant();
    const p = await h().paid(m, "card", { extra: { capture: "manual" } });
    const ref = (await h().internalPayment(p.id)).junction_ref;
    const apply = (type: string, seq: number) =>
      db().transaction((tx) =>
        new PaymentService(tx, h().settings).applyJunctionEvent({ id: `x_${seq}`, type, sequence: seq, ref, payment_id: p.id }),
      );
    expect(await apply("authorization.pending", 5)).toBe("ignored");
    expect(await apply("authorization.teleported", 6)).toBe("ignored");
    expect(await apply("authorization.failed", 7)).toBe("ignored");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ derailment: "payment_state_conflict" }), expect.any(String));
    const notes = (await h().internalPayment(p.id)).events
      .filter((e: { note: string | null }) => e.note)
      .map((e: { note: string }) => e.note);
    expect(notes).toEqual([
      "no-op: payment is authorized",
      "unknown event type 'authorization.teleported'",
      "bank reported failure for authorized payment",
    ]);
  });

  test("status check reschedules when the bank is unreachable and the deadline hasn't passed", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "upi", { scenario: "timeout" })).body.id;
    await h().drain();
    await db().transaction((tx) =>
      new PaymentService(tx, h().settings, new JunctionClient("http://127.0.0.1:1", "k", 200)).statusCheck(id, 1),
    );
    const jobs = await db().execute<{ dedupe_key: string }>(
      sql`SELECT dedupe_key FROM jobs WHERE kind = 'payments.status_check' ORDER BY id`,
    );
    expect(jobs.rows.map((r) => r.dedupe_key)).toContain(`payments:status_check:${id}:2`);
    expect((await h().payment(m, id)).status).toBe("pending");
  });

  test("status check learns the outcome from the bank before the callback arrives", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m)).id, "card", { scenario: "decline:card_declined" })).body.id;
    await h().paymentsWorker.runDue(); // submit only
    await h().junctionWorker.runDue(); // decide
    await h().junctionWorker.runDue(); // resolve (bank now declined; callback queued, not yet delivered)
    await db().transaction((tx) =>
      new PaymentService(tx, h().settings, new JunctionClient(h().junctionUrl, "test-junction-key")).statusCheck(id, 1),
    );
    const p = await h().payment(m, id);
    expect([p.status, p.error_code]).toEqual(["failed", "card_declined"]);
    await h().drain(); // the real callback is now stale
    const notes = (await h().internalPayment(id)).events.map((e: { source: string; note: string | null }) => [e.source, e.note]);
    expect(notes).toContainEqual(["status_check", null]);
  });

  test("void of a captured-at-bank authorization is recorded as rejected; expiry of non-authorized is a no-op", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card", { extra: { capture: "manual" } });
    const ref = (await h().internalPayment(p.id)).junction_ref;
    await new JunctionClient(h().junctionUrl, "test-junction-key").capture(ref, 49_900n);
    await db().transaction((tx) =>
      new PaymentService(tx, h().settings, new JunctionClient(h().junctionUrl, "test-junction-key")).void(p.id, "risk_rejected"),
    );
    const types = (await h().internalPayment(p.id)).events.map((e: { type: string }) => e.type);
    expect(types).toContain("void.rejected");
    const failed = await h().paid(m, "card", { scenario: "decline:card_declined" });
    await db().transaction((tx) => new PaymentService(tx, h().settings).expireAuthorization(failed.id));
    expect((await h().payment(m, failed.id)).status).toBe("failed");
  });

  test("approving a review before authorization does not capture; submit skips non-created payments", async () => {
    const m = await h().merchant();
    const id = (await h().pay(m, (await h().order(m, 2_50_000_00n)).id, "card", { scenario: "timeout" })).body.id;
    const r = await h().staff("POST", `/internal/v1/payments/${id}/risk_review`, { action: "approve" }, "ops");
    expect(r.body.risk.review_status).toBe("approved");
    await h().drain();
    expect((await h().payment(m, id)).status).toBe("pending");
    await db().transaction((tx) => new PaymentService(tx, h().settings).submit(id)); // already pending → no-op
  });

  test("a PaymentService without Junction refuses Junction operations", () => {
    expect(() => new PaymentService(db(), h().settings).junction).toThrow(/needs a JunctionClient/);
  });
});

describe("auth edges", () => {
  test("signed request with a key whose signing secret no longer decrypts is a Derailment", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const m = await h().merchant();
    await db().execute(
      sql`UPDATE api_keys SET signing_key_enc = '\\x01000000000000000000000000000000000000000000000000000000'::bytea WHERE id = ${m.keyId}`,
    );
    const r = await h().call(m, "GET", "/v1/station", undefined, { signed: true });
    expect(r.body.error.code).toBe("MR_INVALID_API_KEY");
    expect(error).toHaveBeenCalledWith({ key_id: m.keyId }, "DERAILMENT: api key signing secret failed to decrypt");
  });

  test("pre-0002 keys without a signing key cannot sign but keep bearer auth", async () => {
    const m = await h().merchant();
    await db().execute(sql`UPDATE api_keys SET signing_key_enc = NULL WHERE id = ${m.keyId}`);
    expect((await h().call(m, "GET", "/v1/station", undefined, { signed: true })).body.error.code).toBe("MR_INVALID_API_KEY");
    expect((await h().call(m, "GET", "/v1/station")).status).toBe(200);
  });

  test("live key on a station whose KYC was later reset", async () => {
    const live = await h().liveMerchant();
    await db().execute(sql`UPDATE stations SET kyc_status = 'pending' WHERE id = ${live.stationId}`);
    expect((await h().call(live, "GET", "/v1/station", undefined, { signed: true })).body.error.code).toBe("MR_KYC_NOT_VERIFIED");
  });

  test("staff session edges: disabled user, expired session, wrong token prefix", async () => {
    const svcStaff = new StaffService(db(), h().settings);
    await db().transaction((tx) =>
      new StaffService(tx, h().settings).createStaff({
        email: "dev@contractor.example",
        fullName: "Dev",
        role: "ops",
        password: STAFF_PASSWORD,
      }),
    );
    const login = (email: string) => h().request("POST", "/internal/v1/auth/login", { json: { email, password: STAFF_PASSWORD } });
    const token = (await login("dev@contractor.example")).body.token;
    await db().execute(sql`UPDATE staff_sessions SET expires_at = now() - interval '1 second'`);
    expect((await h().request("GET", "/internal/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } })).body.error.message).toBe(
      "Railyard session is invalid or expired",
    );
    expect((await h().request("GET", "/internal/v1/auth/me", { headers: { Authorization: "Bearer nope" } })).body.error.message).toBe(
      "invalid Railyard session token",
    );
    await db().execute(sql`UPDATE staff_users SET status = 'disabled'`);
    expect((await login("dev@contractor.example")).body.error.code).toBe("MR_STAFF_LOGIN_FAILED");
    await expect(svcStaff.get("stf_missing")).rejects.toThrow("staff user stf_missing not found");
    expect(await svcStaff.ensureBootstrapAdmin("dev@contractor.example", STAFF_PASSWORD)).toBe(false);
    expect(
      await new StaffService(db(), h().settings, new FrozenClock(new Date())).ensureBootstrapAdmin("boot@mintrail.example", STAFF_PASSWORD),
    ).toBe(true);
  });

  test("explicit nulls for non-nullable settings fail like M1 (500), webhook null clears", async () => {
    const m = await h().merchant();
    expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/settings`, { rate_limit_burst: null })).status).toBe(500);
    expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/settings`, { fee_plan: null })).status).toBe(500);
    const r = await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/settings`, { webhook_url: null, max_payment_amount: null });
    expect(r.body.settings).toMatchObject({ webhook_url: null, max_payment_amount: null });
  });

  test("list endpoints validate cursors", async () => {
    const m = await h().merchant();
    expect((await h().call(m, "GET", "/v1/payments?starting_after=ord_x")).body.error.param).toBe("starting_after");
    expect((await h().call(m, "GET", "/v1/orders?starting_after=pay_x")).body.error.param).toBe("starting_after");
    expect((await h().call(m, "GET", "/v1/orders/ord_00000000000000000000000000/payments")).body.error.code).toBe("MR_ORDER_NOT_FOUND");
  });

  test("malformed JSON body and missing body", async () => {
    const m = await h().merchant();
    expect((await h().call(m, "POST", "/v1/orders", undefined, { raw: '{"amount": }' })).body.error.code).toBe("MR_VALIDATION_FAILED");
    const missing = await h().call(m, "POST", "/v1/orders", undefined);
    expect([missing.status, missing.body.error.message]).toEqual([422, "Field required"]);
  });
});
