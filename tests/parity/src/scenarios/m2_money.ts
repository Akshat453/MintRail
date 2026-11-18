/**
 * M2 regression goldens (recorded from the Node implementation): refunds, disputes,
 * payouts. They pin the public contract of M2 the same way M1's goldens pin M1.
 */
import type { Ctx, Merchant } from "../ctx.js";
import { scenario } from "../scenario.js";

const m2 = { m2: true };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
const BANK = { name: "Shree Ganesh Traders", account_number: "123456789012", ifsc: "HDFC0001234" };

/** A merchant whose balance covers refunds/payouts of gross amounts (MDR is not refunded). */
async function funded(c: Ctx): Promise<Merchant> {
  const m = await c.merchant();
  await c.paid(m, "upi", { amount: 500_000n });
  return m;
}

export default [
  // ---------------------------------------------------------------- refunds
  scenario(
    "m2/refunds/full-lifecycle",
    async (c) => {
      const m = await funded(c);
      const p = await c.paid(m, "card");
      await c.rcall("refund full", m, "POST", `/v1/payments/${p.id}/refunds`, {
        reason: "requested_by_customer",
        notes: { ticket: "T-77" },
      });
      await c.settle();
      await c.rcall("list for payment", m, "GET", `/v1/payments/${p.id}/refunds`);
      await c.rcall("nothing left", m, "POST", `/v1/payments/${p.id}/refunds`, {});
      await c.rcall("balance", m, "GET", "/v1/balance");
    },
    m2,
  ),
  scenario(
    "m2/refunds/partials-and-limit",
    async (c) => {
      const m = await funded(c);
      const p = await c.paid(m, "upi", { amount: 10_000n });
      await c.rcall("partial 1", m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 3_000 });
      await c.rcall("partial 2", m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 4_000 });
      await c.rcall("over the limit", m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 3_001 });
      await c.rcall("the rest", m, "POST", `/v1/payments/${p.id}/refunds`, {});
      await c.settle();
      await c.rcall("list processed", m, "GET", "/v1/refunds?status=processed");
    },
    m2,
  ),
  scenario(
    "m2/refunds/instant-fee-and-validation",
    async (c) => {
      const m = await funded(c);
      const card = await c.paid(m, "card", { amount: 100_000n });
      await c.rcall("instant", m, "POST", `/v1/payments/${card.id}/refunds`, { amount: 40_000, speed: "instant" });
      const nb = await c.paid(m, "netbanking");
      await c.rcall("instant netbanking", m, "POST", `/v1/payments/${nb.id}/refunds`, { speed: "instant" });
      await c.rcall("zero", m, "POST", `/v1/payments/${card.id}/refunds`, { amount: 0 });
      await c.rcall("float", m, "POST", `/v1/payments/${card.id}/refunds`, { amount: 10.5 });
      await c.rcall("bad reason", m, "POST", `/v1/payments/${card.id}/refunds`, { reason: "because" });
      await c.rcall("unknown field", m, "POST", `/v1/payments/${card.id}/refunds`, { amount: 100, why: "x" });
      await c.settle();
    },
    m2,
  ),
  scenario(
    "m2/refunds/bank-failure-returns-funds",
    async (c) => {
      const m = await funded(c);
      const p = await c.paid(m, "card");
      await c.rcall(
        "refund that will fail",
        m,
        "POST",
        `/v1/payments/${p.id}/refunds`,
        { speed: "instant" },
        { headers: { "MintRail-Test-Scenario": "refund_fail:account_closed" } },
      );
      await c.settle();
      await c.rcall("failed refund", m, "GET", "/v1/refunds");
      await c.rcall("balance restored", m, "GET", "/v1/balance");
    },
    m2,
  ),
  scenario(
    "m2/refunds/guards",
    async (c) => {
      const m = await c.merchant();
      const lone = await c.paid(m, "card");
      await c.rcall("insufficient balance", m, "POST", `/v1/payments/${lone.id}/refunds`, {});
      const o = await c.order(m);
      const pending = await c.pay(m, o.id, "upi", { scenario: "timeout" });
      await c.rcall("not captured", m, "POST", `/v1/payments/${(pending.body as { id: string }).id}/refunds`, {});
      await c.rcall("unknown payment", m, "POST", "/v1/payments/pay_00000000000000000000000000/refunds", {});
      await c.rcall("bad id", m, "POST", "/v1/payments/nope/refunds", {});
      await c.rcall("idempotent 1", m, "POST", `/v1/payments/${lone.id}/refunds`, { amount: 100 }, { idempotencyKey: "rf-same" });
      await c.rcall("idempotent 2", m, "POST", `/v1/payments/${lone.id}/refunds`, { amount: 100 }, { idempotencyKey: "rf-same" });
      await c.rcall("key reuse, other body", m, "POST", `/v1/payments/${lone.id}/refunds`, { amount: 200 }, { idempotencyKey: "rf-same" });
      await c.settle();
    },
    m2,
  ),

  // ---------------------------------------------------------------- disputes
  scenario(
    "m2/disputes/evidence-then-won",
    async (c) => {
      const m = await funded(c);
      const p = await c.paid(m, "card");
      await c.rcall("simulate", m, "POST", `/v1/payments/${p.id}/simulate_dispute`, { reason: "product_not_received" });
      await c.settle();
      const list = await c.rcall("needs response", m, "GET", "/v1/disputes?status=needs_response");
      const d = (list.body as { data: { id: string }[] }).data[0]!;
      await c.rupload("word document", m, `/v1/disputes/${d.id}/evidence`, [
        ["invoice.docx", Buffer.from("PK word document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ]);
      await c.rupload("pdf + statement", m, `/v1/disputes/${d.id}/evidence`, [["invoice.pdf", PDF, "application/pdf"]], {
        kind: "shipping_proof",
        text: "Delivered on 3 Nov.",
      });
      await c.rcall("submit", m, "POST", `/v1/disputes/${d.id}/submit`);
      await c.rcall("submit again", m, "POST", `/v1/disputes/${d.id}/submit`);
      await c.settle();
      await c.rcall("won", m, "GET", `/v1/disputes/${d.id}`);
      await c.rcall("refund after won dispute", m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 100 });
    },
    m2,
  ),
  scenario(
    "m2/disputes/accept-and-deadline",
    async (c) => {
      const m = await funded(c);
      const a = await c.paid(m, "card");
      const b = await c.paid(m, "card", { amount: 20_000n });
      await c.call(m, "POST", `/v1/payments/${a.id}/simulate_dispute`, { reason: "fraudulent" });
      await c.call(m, "POST", `/v1/payments/${b.id}/simulate_dispute`, { amount: 5_000 });
      await c.settle();
      const ds = (await c.call(m, "GET", "/v1/disputes")).body as { data: { id: string; payment_id: string }[] };
      const da = ds.data.find((d) => d.payment_id === a.id)!;
      await c.rcall("accept", m, "POST", `/v1/disputes/${da.id}/accept`);
      await c.rcall("disputed is not refundable", m, "POST", `/v1/payments/${a.id}/refunds`, {});
      await c.sql("UPDATE jobs SET run_at = now() WHERE kind = 'payments.dispute_deadline'");
      await c.settle();
      await c.rcall("all disputes", m, "GET", "/v1/disputes");
      await c.rstaff("railyard list", "GET", "/internal/v1/disputes?status=lost", undefined, "ops");
    },
    m2,
  ),
  scenario(
    "m2/disputes/guards",
    async (c) => {
      const live = await c.liveMerchant();
      await c.rcall(
        "simulate in live mode",
        live,
        "POST",
        "/v1/payments/pay_00000000000000000000000000/simulate_dispute",
        {},
        { signed: true },
      );
      const m = await c.merchant();
      const o = await c.order(m);
      const p = await c.pay(m, o.id, "upi", { scenario: "decline:insufficient_funds" });
      await c.settle();
      await c.rcall("dispute a failed payment", m, "POST", `/v1/payments/${(p.body as { id: string }).id}/simulate_dispute`, {});
      await c.rcall("unknown dispute", m, "GET", "/v1/disputes/dsp_00000000000000000000000000");
      await c.rstaff(
        "finance cannot simulate",
        "POST",
        `/internal/v1/payments/${(p.body as { id: string }).id}/simulate_dispute`,
        {},
        "finance",
      );
    },
    m2,
  ),

  // ---------------------------------------------------------------- payouts
  scenario(
    "m2/payouts/imps-and-failure",
    async (c) => {
      const m = await funded(c);
      await c.rcall("imps", m, "POST", "/v1/payouts", {
        amount: 50_000,
        mode: "IMPS",
        purpose: "vendor_bill",
        beneficiary: BANK,
        reference: "INV-2041",
        narration: "Nov invoice",
      });
      await c.rcall("upi", m, "POST", "/v1/payouts", {
        amount: 10_000,
        mode: "UPI",
        purpose: "cashback",
        beneficiary: { name: "Asha Kumari", vpa: "asha@okhdfc" },
      });
      await c.rcall("invalid account fails at bank", m, "POST", "/v1/payouts", {
        amount: 10_000,
        mode: "IMPS",
        beneficiary: { ...BANK, account_number: "999900000000" },
      });
      await c.settle();
      await c.rcall("history", m, "GET", "/v1/payouts");
      await c.rcall("balance", m, "GET", "/v1/balance");
    },
    m2,
  ),
  scenario(
    "m2/payouts/approval-and-limits",
    async (c) => {
      const m = await funded(c);
      await c.rstaff("policy", "PATCH", `/internal/v1/stations/${m.stationId}/policy`, {
        payout_approval_threshold: 50_000,
        payout_daily_limit: 300_000,
      });
      const big = await c.rcall("needs approval", m, "POST", "/v1/payouts", { amount: 60_000, mode: "NEFT", beneficiary: BANK });
      const big2 = await c.rcall("needs approval 2", m, "POST", "/v1/payouts", { amount: 70_000, mode: "NEFT", beneficiary: BANK });
      const big3 = await c.rcall("needs approval 3", m, "POST", "/v1/payouts", { amount: 80_000, mode: "NEFT", beneficiary: BANK });
      const id = (r: { body: unknown }) => (r.body as { id: string }).id;
      await c.rstaff("ops cannot approve", "POST", `/internal/v1/payouts/${id(big)}/approve`, undefined, "ops");
      await c.rstaff("finance approves", "POST", `/internal/v1/payouts/${id(big)}/approve`, undefined, "finance");
      await c.rstaff(
        "finance rejects",
        "POST",
        `/internal/v1/payouts/${id(big2)}/reject`,
        { reason: "beneficiary not on file" },
        "finance",
      );
      await c.rcall("merchant cancels", m, "POST", `/v1/payouts/${id(big3)}/cancel`);
      await c.rcall("daily limit", m, "POST", "/v1/payouts", { amount: 250_000, mode: "NEFT", beneficiary: BANK });
      await c.rcall("bad ifsc", m, "POST", "/v1/payouts", { amount: 1_000, mode: "IMPS", beneficiary: { ...BANK, ifsc: "HDFC123" } });
      await c.rcall("rtgs minimum", m, "POST", "/v1/payouts", { amount: 1_000, mode: "RTGS", beneficiary: BANK });
      await c.settle();
      await c.rstaff("pending approvals", "GET", "/internal/v1/payouts?status=pending_approval", undefined, "finance");
    },
    m2,
  ),
  scenario(
    "m2/payouts/bulk-csv",
    async (c) => {
      const m = await funded(c);
      const csv = [
        "beneficiary_name,account_number,ifsc,vpa,amount,mode,purpose,reference,narration",
        "Asha Kumari,123456789012,ICIC0000123,,1500.50,IMPS,salary,EMP-1,Nov salary",
        "Ravi Sharma,,,ravi@okicici,250,UPI,cashback,,",
        "No Bank,12,HDFC0001234,,100,IMPS,salary,,",
        "Bad Amount,123456789012,HDFC0001234,,abc,NEFT,vendor_bill,,",
      ].join("\n");
      const r = await c.rupload("upload", m, "/v1/payouts/bulk", [["november.csv", Buffer.from(csv), "text/csv"]]);
      await c.rupload("not a csv", m, "/v1/payouts/bulk", [["x.csv", Buffer.from("just one line"), "text/csv"]]);
      await c.settle();
      await c.rcall("batch", m, "GET", `/v1/payout_batches/${(r.body as { id: string }).id}`);
    },
    m2,
  ),
];
