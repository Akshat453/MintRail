/** M2 regression goldens: webhooks (Signal), settlements (Depot), dashboard and Railyard ops. */
import { scenario } from "../scenario.js";

const m2 = { m2: true };

export default [
  // ---------------------------------------------------------------- webhooks
  scenario(
    "m2/webhooks/endpoint-crud-and-policy",
    async (c) => {
      const m = await c.merchant();
      const ep = await c.rcall("create", m, "POST", "/v1/webhook_endpoints", {
        url: "https://hooks.kaveri.example/mintrail",
        enabled_events: ["refund.processed", "payment.captured"],
      });
      const id = (ep.body as { id: string }).id;
      await c.rcall("ftp", m, "POST", "/v1/webhook_endpoints", { url: "ftp://hooks.kaveri.example/x" });
      await c.rcall("private ip", m, "POST", "/v1/webhook_endpoints", { url: "https://10.1.2.3/x" });
      await c.rcall("unknown event", m, "POST", "/v1/webhook_endpoints", {
        url: "https://hooks.kaveri.example/y",
        enabled_events: ["payment.exploded"],
      });
      await c.rcall("disable", m, "PATCH", `/v1/webhook_endpoints/${id}`, { status: "disabled" });
      await c.rcall("rotate", m, "POST", `/v1/webhook_endpoints/${id}/rotate_secret`);
      await c.rcall("list", m, "GET", "/v1/webhook_endpoints");
      await c.rcall("delete", m, "DELETE", `/v1/webhook_endpoints/${id}`);
      await c.rcall("gone", m, "GET", `/v1/webhook_endpoints/${id}`);
    },
    m2,
  ),
  scenario(
    "m2/webhooks/signed-delivery-and-replay",
    async (c) => {
      const rx = await c.receiver();
      const m = await c.merchant();
      await c.rcall("endpoint", m, "POST", "/v1/webhook_endpoints", {
        url: rx.url,
        enabled_events: ["payment.captured", "refund.created", "refund.processed"],
      });
      const p = await c.paid(m, "card", { amount: 300_000n });
      await c.call(m, "POST", `/v1/payments/${p.id}/refunds`, { amount: 10_000 });
      await c.settle();
      c.note(
        "received",
        rx.got.map((g) => g).sort((a, b) => (a.type < b.type ? -1 : 1)),
      );
      const ds = await c.rcall("deliveries", m, "GET", "/v1/webhook_deliveries");
      const first = (ds.body as { data: { id: string }[] }).data.at(-1)!;
      await c.rcall("replay", m, "POST", `/v1/webhook_deliveries/${first.id}/replay`);
      await c.settle();
      c.note("after replay", rx.got.length);
      await c.rcall("events", m, "GET", "/v1/events?type=payment.captured");
    },
    m2,
  ),

  // ---------------------------------------------------------------- settlements
  scenario(
    "m2/settlements/batch-report-reconcile",
    async (c) => {
      const m = await c.merchant();
      const a = await c.paid(m, "card", { amount: 100_000n });
      await c.paid(m, "upi", { amount: 200_000n });
      await c.call(m, "POST", `/v1/payments/${a.id}/refunds`, { amount: 30_000 });
      await c.call(m, "POST", "/v1/payouts", {
        amount: 20_000,
        mode: "IMPS",
        beneficiary: { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" },
      });
      await c.settle();
      await c.rdepot("too early (T+2 cutoff not passed)", "/internal/depot/v1/runs", { date: c.istDate(1) });
      const run = await c.rdepot("run", "/internal/depot/v1/runs", { date: c.istDate(3) });
      await c.rdepot("idempotent rerun", "/internal/depot/v1/runs", { date: c.istDate(3) });
      const stl = (run.body as { settlements: { id: string }[] }).settlements[0]!;
      await c.rcall("entries", m, "GET", `/v1/settlements/${stl.id}/entries`);
      const csv = await c.call(m, "GET", `/v1/settlements/${stl.id}/report`);
      c.note(
        "csv",
        csv.text.split("\r\n").map((l) =>
          l
            .split(",")
            .filter((_, i) => i >= 2 && i !== 4)
            .join(","),
        ),
      ); // without ids/dates/occurred_at
      await c.rdepot("reconcile", "/internal/depot/v1/reconciliations");
      await c.rstaff("railyard settlement", "GET", `/internal/v1/settlements/${stl.id}`, undefined, "finance");
      await c.rstaff("ops cannot run", "POST", "/internal/v1/settlements/run", {}, "ops");
    },
    m2,
  ),
  scenario(
    "m2/settlements/rolling-reserve",
    async (c) => {
      const m = await c.merchant();
      await c.rstaff("reserve policy", "PATCH", `/internal/v1/stations/${m.stationId}/policy`, { reserve_bps: 1000, reserve_hold_days: 7 });
      await c.paid(m, "upi", { amount: 100_000n });
      await c.rdepot("run", "/internal/depot/v1/runs", { date: c.istDate(3) });
      await c.rcall("balance after hold", m, "GET", "/v1/balance");
    },
    m2,
  ),

  // ---------------------------------------------------------------- dashboard
  scenario(
    "m2/dashboard/session-roles-data",
    async (c) => {
      const m = await c.merchant();
      const p = await c.paid(m, "card", { amount: 120_000n });
      await c.paid(m, "upi", { amount: 80_000n });
      const owner = await c.dashboard(m.stationId, "owner");
      await c.rdash("me", owner, "GET", "/dashboard/v1/me");
      await c.rdash("live needs kyc", { ...owner, "MintRail-Mode": "live" }, "GET", "/dashboard/v1/me");
      await c.rdash("payments upi", owner, "GET", "/dashboard/v1/payments?method=upi");
      await c.rdash("refund", owner, "POST", `/dashboard/v1/payments/${p.id}/refunds`, { amount: 20_000, reason: "order_cancelled" });
      const viewer = await c.dashboard(m.stationId, "viewer");
      await c.rdash("viewer cannot refund", viewer, "POST", `/dashboard/v1/payments/${p.id}/refunds`, { amount: 100 });
      await c.rdash("bad login", {}, "POST", "/dashboard/v1/auth/login", {
        email: "nobody@merchant.parity.example",
        password: "wrong-password-1",
      });
      await c.rdash("logout", owner, "POST", "/dashboard/v1/auth/logout");
      await c.rdash("after logout", owner, "GET", "/dashboard/v1/me");
      await c.settle();
    },
    m2,
  ),

  // ---------------------------------------------------------------- Railyard
  scenario(
    "m2/railyard/derailments-and-policy",
    async (c) => {
      const d = await c.rstaff(
        "open",
        "POST",
        "/internal/v1/derailments",
        { title: "UPI success rate dip", severity: "sev2", summary: "Collect requests timing out", affected: ["junction", "upi"] },
        "ops",
      );
      const id = (d.body as { id: string }).id;
      await c.rstaff("mitigate", "POST", `/internal/v1/derailments/${id}/notes`, { body: "Failed over", status: "mitigated" }, "security");
      await c.rstaff("resolve", "POST", `/internal/v1/derailments/${id}/notes`, { body: "Recovered", status: "resolved" }, "finance");
      await c.rstaff("late note", "POST", `/internal/v1/derailments/${id}/notes`, { body: "late" }, "ops");
      const m = await c.merchant();
      await c.rstaff("policy read", "GET", `/internal/v1/stations/${m.stationId}/policy`, undefined, "security");
      await c.rstaff("policy out of range", "PATCH", `/internal/v1/stations/${m.stationId}/policy`, { reserve_bps: 9000 });
      await c.rstaff(
        "security cannot write policy",
        "PATCH",
        `/internal/v1/stations/${m.stationId}/policy`,
        { reserve_bps: 100 },
        "security",
      );
      await c.rstaff("audit", "GET", "/internal/v1/audit_log?limit=10");
    },
    m2,
  ),
];
