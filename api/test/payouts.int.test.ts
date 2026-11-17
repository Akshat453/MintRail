/** Freight payouts (M2): validation, rails, approvals, daily limit, bank outcomes, bulk CSV, ledger. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import type { Merchant } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const BANK = { name: "Shree Ganesh Traders", account_number: "123456789012", ifsc: "HDFC0001234" };
const balance = async (m: Merchant) => (await h().call(m, "GET", "/v1/balance?currency=INR")).body.balances[0].balance as bigint;
const funded = async () => {
  const m = await h().merchant();
  for (let i = 0; i < 3; i++) await h().paid(m, "upi", { amount: 900_000n });
  return m;
};
const payout = (m: Merchant, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h().call(m, "POST", "/v1/payouts", { mode: "IMPS", purpose: "vendor_bill", beneficiary: BANK, ...body }, { headers });

describe("payouts", () => {
  test("IMPS payout: queued → processing → processed with UTR; funds reserved at creation; event emitted", async () => {
    const m = await funded();
    const before = await balance(m);
    const p = await payout(m, { amount: 50_000n, reference: "INV-2041", narration: "Nov invoice" });
    expect(p.status, p.text).toBe(201);
    expect(p.body).toMatchObject({
      status: "queued",
      amount: 50_000n,
      beneficiary: { account_number: "••••••••9012", ifsc: "HDFC0001234" },
    });
    expect(await balance(m)).toBe(before - 50_000n);
    await h().drainAll();
    const done = (await h().call(m, "GET", `/v1/payouts/${p.body.id}`)).body;
    expect(done.status).toBe("processed");
    expect(done.utr).toMatch(/^JUNC\d{6}\d{10}$/);
    expect((await h().call(m, "GET", "/v1/events?type=payout.processed")).body.data).toHaveLength(1);
  });

  test("bank failure returns the funds; invalid beneficiary details are rejected up front", async () => {
    const m = await funded();
    const before = await balance(m);
    const p = await payout(m, { amount: 10_000n, beneficiary: { ...BANK, account_number: "999900000000" } });
    await h().drainAll();
    const f = (await h().call(m, "GET", `/v1/payouts/${p.body.id}`)).body;
    expect([f.status, f.failure_reason]).toEqual(["failed", "invalid_account"]);
    expect(await balance(m)).toBe(before);
    expect((await payout(m, { amount: 10_000n, beneficiary: { ...BANK, ifsc: "HDFC1234" } })).body.error.code).toBe(
      "MR_INVALID_BENEFICIARY",
    );
    expect((await payout(m, { amount: 10_000n, mode: "UPI", beneficiary: { name: "Asha K", vpa: "asha@okhdfc" } })).status).toBe(201);
    expect((await payout(m, { amount: 1_000n, mode: "RTGS" })).body.error.code).toBe("MR_INVALID_AMOUNT");
  });

  test("large payouts need Railyard approval (finance), can be rejected or cancelled", async () => {
    const m = await funded();
    expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/policy`, { payout_approval_threshold: 5_000_00n })).status).toBe(
      200,
    );
    expect((await payout(m, { amount: 4_999_00n })).body.status).toBe("queued");
    const big = await payout(m, { amount: 6_000_00n });
    expect(big.body.status).toBe("pending_approval");
    expect((await h().staff("POST", `/internal/v1/payouts/${big.body.id}/approve`, undefined, "ops")).status).toBe(403);
    const ok = await h().staff("POST", `/internal/v1/payouts/${big.body.id}/approve`, undefined, "finance");
    expect([ok.status, ok.body.status, ok.body.approved_by]).toEqual([200, "queued", expect.stringMatching(/^stf_/)]);
    await h().drainAll();
    expect((await h().call(m, "GET", `/v1/payouts/${big.body.id}`)).body.status).toBe("processed");

    const before = await balance(m);
    const r = await payout(m, { amount: 6_000_00n });
    const rej = await h().staff("POST", `/internal/v1/payouts/${r.body.id}/reject`, { reason: "beneficiary not on file" }, "finance");
    expect(rej.body.status).toBe("rejected");
    const c = await payout(m, { amount: 6_000_00n });
    expect((await h().call(m, "POST", `/v1/payouts/${c.body.id}/cancel`)).body.status).toBe("cancelled");
    expect(await balance(m)).toBe(before);
    const audit = (await h().staff("GET", "/internal/v1/audit_log?limit=20")).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["payout.approve", "payout.reject"]));
  });

  test("daily limit per IST day (failed/rejected payouts don't count)", async () => {
    const m = await funded();
    const staff = await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/policy`, { payout_daily_limit: 30_000n });
    expect(staff.status).toBe(200);
    expect((await payout(m, { amount: 20_000n })).status).toBe(201);
    const over = await payout(m, { amount: 10_001n });
    expect([over.status, over.body.error.code, over.body.error.details.used_today]).toEqual([422, "MR_PAYOUT_LIMIT_EXCEEDED", 20_000n]);
    expect((await payout(m, { amount: 10_000n })).status).toBe(201);
  });

  test("bulk CSV: good rows become payouts, bad rows are reported with their line numbers", async () => {
    const m = await funded();
    const csv = [
      "beneficiary_name,account_number,ifsc,vpa,amount,mode,purpose,reference,narration",
      "Asha Kumari,123456789012,ICIC0000123,,1500.50,IMPS,salary,EMP-1,Nov salary",
      'Ravi "RK" Sharma,,,ravi@okicici,250,UPI,cashback,,',
      "No Bank,12,HDFC0001234,,100,IMPS,salary,,",
      "Too Much,123456789012,HDFC0001234,,abc,NEFT,vendor_bill,,",
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "november.csv");
    const res = await fetch(`${h().platformUrl}/v1/payouts/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${m.secret}` },
      body: form,
    });
    const body = JSON.parse(await res.text());
    expect(res.status).toBe(201);
    expect([body.row_count, body.accepted_count, body.rejected_count, body.total_amount]).toEqual([4, 2, 2, 175_050]);
    expect(body.errors.map((e: { row: number; code: string }) => [e.row, e.code])).toEqual([
      [4, "MR_INVALID_BENEFICIARY"],
      [5, "MR_INVALID_AMOUNT"],
    ]);
    const n = await db().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM payouts WHERE batch_id = ${body.id}`);
    expect(n.rows[0]!.n).toBe("2");
  });
});
