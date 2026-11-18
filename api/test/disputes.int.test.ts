/** Disputes (M2): opened by Junction, evidence upload + content checks, submit/accept/deadline, ledger effects. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { LedgerService } from "@mintrail/ledger";

import type { Merchant } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function disputed(m: Merchant, body: Record<string, unknown> = {}) {
  const p = await h().paid(m, "card");
  const s = await h().call(m, "POST", `/v1/payments/${p.id}/simulate_dispute`, { reason: "product_not_received", ...body });
  expect(s.status, s.text).toBe(202);
  await h().drainAll();
  const list = (await h().call(m, "GET", `/v1/disputes?payment_id=${p.id}`)).body.data;
  expect(list).toHaveLength(1);
  return { p, d: list[0] };
}

const upload = async (m: Merchant, disputeId: string, files: [string, Buffer, string][], fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [name, buf, type] of files) form.append("files", new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${h().platformUrl}/v1/disputes/${disputeId}/evidence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${m.secret}` },
    body: form,
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
};

const disputeReserve = async (stationId: string) => {
  const r = await db().execute<{ b: string }>(
    sql`SELECT (b.credits_total - b.debits_total)::text AS b FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.code = ${`station:${stationId}:test:dispute_reserve:INR`}`,
  );
  return BigInt(r.rows[0]?.b ?? "0");
};

describe("disputes", () => {
  test("opened by Junction: needs_response, deadline set, funds withdrawn into dispute_reserve, event emitted", async () => {
    const m = await h().merchant();
    const { d } = await disputed(m);
    expect(d).toMatchObject({ object: "dispute", status: "needs_response", amount: 49_900n, reason: "product_not_received" });
    expect(d.network_reference).toMatch(/^DSP\d{12}$/);
    expect(Date.parse(d.evidence_due_by) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(await disputeReserve(m.stationId)).toBe(-49_900n);
    const types = (await h().call(m, "GET", "/v1/events")).body.data.map((e: { type: string }) => e.type);
    expect(types).toContain("dispute.created");
  });

  test("evidence: PDF/PNG accepted; other document types rejected; submit → won returns the funds", async () => {
    const m = await h().merchant();
    const { d } = await disputed(m);
    const bad = await upload(m, d.id, [
      ["invoice.docx", Buffer.from("PK\x03\x04 word document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]);
    expect([bad.status, bad.body.error.code]).toEqual([422, "MR_INVALID_EVIDENCE"]);
    const ok = await upload(
      m,
      d.id,
      [
        ["invoice.pdf", PDF, "application/pdf"],
        ["courier.png", PNG, "image/png"],
      ],
      { kind: "shipping_proof", text: "Delivered on 3 Nov, signed by customer." },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.evidence.map((e: { content_type: string }) => e.content_type)).toEqual(["application/pdf", "image/png"]);
    expect(ok.body.evidence_text).toContain("Delivered");
    const dl = await h().call(m, "GET", `/v1/disputes/${d.id}/evidence/${ok.body.evidence[0].id}`);
    expect([dl.status, dl.headers["content-type"], dl.text.startsWith("%PDF-")]).toEqual([200, "application/pdf", true]);
    const sub = await h().call(m, "POST", `/v1/disputes/${d.id}/submit`);
    expect(sub.body.status).toBe("under_review");
    await h().drainAll();
    const won = (await h().call(m, "GET", `/v1/disputes/${d.id}`)).body;
    expect([won.status, won.outcome_reason]).toEqual(["won", "evidence accepted by the issuer"]);
    expect(await disputeReserve(m.stationId)).toBe(0n);
  });

  test("upload limits: oversized file → 413; too many files → rejected", async () => {
    const m = await h().merchant();
    const { d } = await disputed(m);
    const big = Buffer.concat([PDF, Buffer.alloc(h().settings.evidence_max_bytes)]);
    const r = await upload(m, d.id, [["big.pdf", big, "application/pdf"]]);
    expect([r.status, r.body.error.code]).toEqual([413, "MR_PAYLOAD_TOO_LARGE"]);
    const many = await upload(
      m,
      d.id,
      Array.from({ length: 6 }, (_, i) => [`f${i}.pdf`, PDF, "application/pdf"] as [string, Buffer, string]),
    );
    expect(many.status).toBe(422);
  });

  test("accept → lost: funds go to the network; outcome scenario 'lose' loses even with evidence", async () => {
    const m = await h().merchant();
    const { d } = await disputed(m);
    const a = await h().call(m, "POST", `/v1/disputes/${d.id}/accept`);
    expect([a.body.status, a.body.outcome_reason]).toEqual(["lost", "accepted by merchant"]);
    expect(await disputeReserve(m.stationId)).toBe(-49_900n);
    const txns = await new LedgerService(db()).transactionsForReference("dispute", d.id);
    expect(txns.map((t) => t.idempotencyKey)).toEqual([`dispute_opened:${d.id}`, `dispute_lost:${d.id}`]);
    await h().drainAll(); // the bank's own dispute.lost callback is a no-op now
    const { d: d2 } = await disputed(m, { outcome: "lose" });
    await upload(m, d2.id, [["r.pdf", PDF, "application/pdf"]]);
    await h().call(m, "POST", `/v1/disputes/${d2.id}/submit`);
    await h().drainAll();
    expect((await h().call(m, "GET", `/v1/disputes/${d2.id}`)).body.status).toBe("lost");
  });

  test("missing the evidence deadline loses the dispute", async () => {
    const m = await h().merchant();
    const { d } = await disputed(m);
    await db().execute(sql`UPDATE jobs SET run_at = now() WHERE kind = 'payments.dispute_deadline'`);
    await h().drainAll();
    const lost = (await h().call(m, "GET", `/v1/disputes/${d.id}`)).body;
    expect([lost.status, lost.outcome_reason]).toEqual(["lost", "evidence deadline passed"]);
  });

  test("disputed amounts are no longer refundable; disputes only simulated in test mode", async () => {
    const m = await h().merchant();
    const { p } = await disputed(m);
    await h().paid(m, "upi", { amount: 200_000n });
    const r = await h().call(m, "POST", `/v1/payments/${p.id}/refunds`, {});
    expect(r.body.error.code).toBe("MR_PAYMENT_NOT_REFUNDABLE");
    const staff = await h().staff("POST", `/internal/v1/payments/${p.id}/simulate_dispute`, { reason: "fraudulent" }, "finance");
    expect(staff.status).toBe(403);
  });
});
