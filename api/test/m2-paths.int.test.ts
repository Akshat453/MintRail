/** M2 guard and edge paths: state conflicts, filters, callbacks, reports, Railyard reads. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { signatures, stringifyJson } from "@mintrail/shared";

import type { Merchant } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const BANK = { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" };

const funded = async (): Promise<Merchant> => {
  const m = await h().merchant();
  await h().paid(m, "upi", { amount: 900_000n });
  return m;
};
const callback = (event: Record<string, unknown>) => {
  const body = stringifyJson(event);
  return h().request("POST", "/internal/junction/v1/callbacks", {
    raw: body,
    headers: {
      "Junction-Signature": signatures.header(Buffer.from(h().settings.junction_callback_secret), Math.floor(Date.now() / 1000), body),
    },
  });
};
const upload = async (m: Merchant, path: string, files: [string, Buffer, string][], fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [n, b, t] of files) form.append("files", new Blob([new Uint8Array(b)], { type: t }), n);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${h().platformUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${m.secret}` }, body: form });
  return { status: r.status, body: JSON.parse(await r.text()) };
};

describe("refund and payout edge paths", () => {
  test("refund filters, lookups and scenario rules", async () => {
    const m = await funded();
    const p = await h().paid(m, "card");
    const a = (await h().call(m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 100n })).body;
    const b = (await h().call(m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 200n })).body;
    expect((await h().call(m, "GET", `/v1/refunds?limit=1`)).body).toMatchObject({ has_more: true, data: [{ id: b.id }] });
    expect((await h().call(m, "GET", `/v1/refunds?starting_after=${b.id}`)).body.data.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect((await h().call(m, "GET", `/v1/refunds?payment_id=${p.id}&status=pending`)).body.data).toHaveLength(2);
    expect((await h().call(m, "GET", "/v1/refunds?starting_after=nope")).status).toBe(400);
    expect((await h().call(m, "GET", "/v1/refunds/rfd_00000000000000000000000000")).body.error.code).toBe("MR_REFUND_NOT_FOUND");
    const bad = await h().call(
      m,
      "POST",
      `/v1/payments/${p.id}/refunds`,
      { amount: 100n },
      { headers: { "MintRail-Test-Scenario": "Not A Scenario!" } },
    );
    expect(bad.body.error.param).toBe("MintRail-Test-Scenario");
    const live = await h().liveMerchant();
    const lr = await h().call(
      live,
      "POST",
      `/v1/payments/${p.id}/refunds`,
      {},
      { signed: true, headers: { "MintRail-Test-Scenario": "refund_fail" } },
    );
    expect(lr.body.error.code).toBe("MR_SCENARIO_NOT_ALLOWED");
    await h().drainAll();
    // A redelivered bank callback is a no-op.
    const ev = { id: `jev_dup_${a.id}`, type: "refund.processed", sequence: 1, ref: "RFN000000000001", refund_id: a.id };
    expect((await callback(ev)).body.outcome).toBe("ignored");
    expect((await callback(ev)).body.outcome).toBe("duplicate");
    expect((await callback({ id: "x", type: "refund.processed" })).status).toBe(400);
    expect((await callback({ id: "jev_unknown", type: "dispute.reopened", ref: "DSP1", payment_id: p.id, amount: 1n })).body.outcome).toBe(
      "ignored",
    );
  });

  test("payout state conflicts, lists and live scenarios", async () => {
    const m = await funded();
    const q = (await h().call(m, "POST", "/v1/payouts", { amount: 10_000n, mode: "IMPS", beneficiary: BANK })).body;
    expect((await h().call(m, "POST", `/v1/payouts/${q.id}/cancel`)).body.error.code).toBe("MR_PAYOUT_NOT_ACTIONABLE");
    expect((await h().staff("POST", `/internal/v1/payouts/${q.id}/approve`, undefined, "finance")).body.error.code).toBe(
      "MR_PAYOUT_NOT_ACTIONABLE",
    );
    expect((await h().staff("POST", `/internal/v1/payouts/${q.id}/reject`, { reason: "no thanks" }, "finance")).body.error.code).toBe(
      "MR_PAYOUT_NOT_ACTIONABLE",
    );
    expect((await h().call(m, "GET", "/v1/payouts/pout_00000000000000000000000000")).body.error.code).toBe("MR_PAYOUT_NOT_FOUND");
    expect((await h().call(m, "GET", "/v1/payout_batches/pbat_00000000000000000000000000")).status).toBe(404);
    const failing = await h().call(
      m,
      "POST",
      "/v1/payouts",
      { amount: 10_000n, mode: "IMPS", beneficiary: BANK },
      { headers: { "MintRail-Test-Scenario": "payout_fail:beneficiary_bank_offline" } },
    );
    expect(
      (
        await h().call(
          m,
          "POST",
          "/v1/payouts",
          { amount: 10_000n, mode: "IMPS", beneficiary: BANK },
          { headers: { "MintRail-Test-Scenario": "BAD!" } },
        )
      ).status,
    ).toBe(400);
    await h().drainAll();
    expect((await h().call(m, "GET", `/v1/payouts/${failing.body.id}`)).body.failure_reason).toBe("beneficiary_bank_offline");
    expect((await h().call(m, "GET", "/v1/payouts?status=failed")).body.data).toHaveLength(1);
    expect((await h().call(m, "GET", `/v1/payouts?limit=1&starting_after=${failing.body.id}`)).body.data).toHaveLength(1);
    expect((await h().staff("GET", `/internal/v1/payouts?station_id=${m.stationId}`, undefined, "ops")).body.data).toHaveLength(2);
    const live = await h().liveMerchant();
    const lp = await h().call(
      live,
      "POST",
      "/v1/payouts",
      { amount: 10_000n, mode: "IMPS", beneficiary: BANK },
      { signed: true, headers: { "MintRail-Test-Scenario": "payout_fail" } },
    );
    expect(lp.body.error.code).toBe("MR_SCENARIO_NOT_ALLOWED");
    const form = new FormData();
    expect(
      (await fetch(`${h().platformUrl}/v1/payouts/bulk`, { method: "POST", headers: { Authorization: `Bearer ${m.secret}` }, body: form }))
        .status,
    ).toBe(400);
    const json = await h().call(m, "POST", "/v1/payouts/bulk", { not: "multipart" });
    expect(json.status).toBe(422);
    const missing = new FormData();
    missing.append("file", new Blob(["name,amount\nA,1"], { type: "text/csv" }), "x.csv");
    const mres = await fetch(`${h().platformUrl}/v1/payouts/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${m.secret}` },
      body: missing,
    });
    expect((JSON.parse(await mres.text()) as { error: { message: string } }).error.message).toContain("missing columns");
  });
});

describe("dispute edge paths", () => {
  test("evidence and action guards, staff handling, lists", async () => {
    const m = await funded();
    const p = await h().paid(m, "card");
    await h().call(m, "POST", `/v1/payments/${p.id}/simulate_dispute`, { amount: 10_000n });
    await h().drainAll();
    const d = (await h().call(m, "GET", "/v1/disputes")).body.data[0];
    expect((await upload(m, `/v1/disputes/${d.id}/evidence`, [], {})).body.error.code).toBe("MR_INVALID_EVIDENCE");
    expect((await upload(m, `/v1/disputes/${d.id}/evidence`, [], { kind: "selfie", text: "x" })).status).toBe(422);
    expect((await h().call(m, "POST", `/v1/disputes/${d.id}/submit`)).body.error.code).toBe("MR_INVALID_EVIDENCE");
    const up = await upload(m, `/v1/disputes/${d.id}/evidence`, [["receipt.pdf", PDF, "application/pdf"]], { kind: "receipt" });
    const fileId = up.body.evidence[0].id;
    const dl = await h().staff("GET", `/internal/v1/disputes/${d.id}/evidence/${fileId}`, undefined, "ops");
    expect([dl.status, dl.headers["content-disposition"]]).toEqual([200, 'attachment; filename="receipt.pdf"']);
    expect(
      (await h().staff("GET", `/internal/v1/disputes/${d.id}/evidence/file_00000000000000000000000000`, undefined, "ops")).status,
    ).toBe(404);
    expect((await h().staff("POST", `/internal/v1/disputes/${d.id}/submit`, undefined, "ops")).body.status).toBe("under_review");
    expect((await upload(m, `/v1/disputes/${d.id}/evidence`, [["late.pdf", PDF, "application/pdf"]])).body.error.code).toBe(
      "MR_DISPUTE_NOT_ACTIONABLE",
    );
    expect((await h().call(m, "POST", `/v1/disputes/${d.id}/accept`)).body.error.code).toBe("MR_DISPUTE_NOT_ACTIONABLE");
    await h().drainAll();
    expect((await h().call(m, "GET", "/v1/disputes?status=won")).body.data).toHaveLength(1);
    expect((await h().call(m, "GET", `/v1/disputes?starting_after=${d.id}`)).body.data).toEqual([]);
    expect((await h().call(m, "GET", "/v1/disputes/dsp_00000000000000000000000000")).body.error.code).toBe("MR_DISPUTE_NOT_FOUND");
    expect((await h().staff("GET", `/internal/v1/disputes?station_id=${m.stationId}`, undefined, "finance")).body.data).toHaveLength(1);
    // deadline passed → submission refused
    const p2 = await h().paid(m, "card");
    await h().call(m, "POST", `/v1/payments/${p2.id}/simulate_dispute`, {});
    await h().drainAll();
    const d2 = (await h().call(m, "GET", `/v1/disputes?payment_id=${p2.id}`)).body.data[0];
    await upload(m, `/v1/disputes/${d2.id}/evidence`, [], { text: "late" });
    await db().execute(sql`UPDATE disputes SET evidence_due_by = now() - interval '1 hour' WHERE id = ${d2.id}`);
    expect((await h().call(m, "POST", `/v1/disputes/${d2.id}/submit`)).body.error.message).toContain("deadline");
    expect((await h().staff("POST", `/internal/v1/disputes/${d2.id}/accept`, undefined, "ops")).body.status).toBe("lost");
    // a chargeback for a payment MintRail doesn't know is ignored (and logged as a Derailment)
    expect(
      (
        await callback({
          id: "jev_DSP999",
          type: "dispute.opened",
          ref: "DSP999999999999",
          payment_id: "pay_00000000000000000000000000",
          amount: 100n,
          due_at: "2026-12-01T00:00:00+00:00",
        })
      ).body.outcome,
    ).toBe("ignored");
    expect((await callback({ id: "jev_DSP998_2", type: "dispute.won", ref: "DSP998", payment_id: "x", amount: 1n })).body.outcome).toBe(
      "ignored",
    );
  });
});

describe("reads", () => {
  test("events, endpoints, deliveries, FX, reports and Railyard reads", async () => {
    const m = await funded();
    const ep = (await h().call(m, "POST", "/v1/webhook_endpoints", { url: "http://127.0.0.1:9/hook" })).body;
    await h().paid(m, "card");
    await h().drainAll();
    const ev = (await h().call(m, "GET", "/v1/events?limit=1")).body.data[0];
    expect((await h().call(m, "GET", `/v1/events/${ev.id}`)).body.id).toBe(ev.id);
    expect((await h().call(m, "GET", "/v1/events/evt_00000000000000000000000000")).body.error.code).toBe("MR_EVENT_NOT_FOUND");
    expect((await h().call(m, "GET", `/v1/webhook_endpoints/${ep.id}`)).body.url).toBe("http://127.0.0.1:9/hook");
    const dels = (await h().call(m, "GET", `/v1/webhook_deliveries?status=failed&endpoint_id=${ep.id}`)).body.data;
    expect(dels.length).toBeGreaterThan(0);
    expect((await h().call(m, "GET", `/v1/webhook_deliveries?event_id=${dels[0].event_id}`)).body.data).toHaveLength(1);
    expect((await h().call(m, "GET", "/v1/webhook_deliveries/whd_00000000000000000000000000")).status).toBe(404);
    await h().call(m, "PATCH", `/v1/webhook_endpoints/${ep.id}`, { status: "disabled" });
    expect((await h().call(m, "POST", `/v1/webhook_deliveries/${dels[0].id}/replay`)).status).toBe(400);
    await h().call(m, "PATCH", `/v1/webhook_endpoints/${ep.id}`, {
      url: "https://hooks.example.com/new",
      description: "moved",
      enabled_events: ["refund.processed"],
      status: "enabled",
    });
    await db().execute(
      sql`INSERT INTO fx_rates (id, base, quote, rate, source, as_of) VALUES ('fxr_01m7na6s80td70nakmzackgbz4', 'USD', 'INR', '83.1234', 'test', now())`,
    );
    expect((await h().call(m, "GET", "/v1/fx_rates/latest")).body.rate).toBe("83.1234000000");
    const owner = await h().dashboardLogin(m.stationId);
    for (const kind of ["payments", "refunds", "settlements", "payouts"]) {
      expect((await h().dash(owner, "GET", `/dashboard/v1/reports/${kind}?from=2020-01-01&to=2099-12-31`)).status).toBe(200);
    }
    expect(
      (await h().dash(owner, "GET", "/dashboard/v1/payments?from=2020-01-01&to=2099-12-31&status=captured")).body.data.length,
    ).toBeGreaterThan(0);
    expect((await h().dash(owner, "GET", "/dashboard/v1/payments/pay_00000000000000000000000000")).status).toBe(404);
    expect((await h().dash(owner, "POST", "/dashboard/v1/api_keys/key_00000000000000000000000000/revoke")).status).toBe(404);
    expect((await h().dash(owner, "GET", "/dashboard/v1/overview?days=1&currency=USD")).body.totals.payments).toBe(0n);
    expect((await h().staff("GET", `/internal/v1/stations/${m.stationId}/payments?limit=1`, undefined, "ops")).body.has_more).toBe(true);
    const pid = (await h().call(m, "GET", "/v1/payments?limit=1")).body.data[0].id;
    expect((await h().staff("GET", `/internal/v1/payments/${pid}/refunds`, undefined, "ops")).body.data).toEqual([]);
    expect((await h().staff("GET", "/internal/v1/settlements/stl_00000000000000000000000000", undefined, "finance")).status).toBe(404);
    expect((await h().staff("GET", "/internal/v1/derailments/drl_00000000000000000000000000", undefined, "ops")).status).toBe(404);
  });
});
