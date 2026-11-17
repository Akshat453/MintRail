import { scenario } from "../scenario.js";

const base = {
  legal_name: "Nilgiri Books LLP",
  display_name: "Nilgiri Books",
  email: "hello@nilgiri.example",
  business_category: "5942",
};

export default [
  scenario("stations/create-default", async (c) => {
    await c.rstaff("create", "POST", "/internal/v1/stations", base);
  }),
  scenario("stations/create-with-settings", async (c) => {
    await c.rstaff("create with settings", "POST", "/internal/v1/stations", {
      ...base,
      default_currency: "INR",
      settings: { fee_plan: "growth", settlement_schedule: "T+1", auto_capture: false },
    });
  }),
  scenario("stations/create-usd-default", async (c) => {
    await c.rstaff("create USD station", "POST", "/internal/v1/stations", { ...base, default_currency: "USD" });
  }),
  scenario("stations/duplicate-email", async (c) => {
    await c.rstaff("first", "POST", "/internal/v1/stations", base);
    await c.rstaff("same email, other case", "POST", "/internal/v1/stations", { ...base, email: "HELLO@nilgiri.example" });
  }),
  ...(
    [
      ["bad-email", { email: "not-an-email" }],
      ["short-mcc", { business_category: "58" }],
      ["bad-currency", { default_currency: "XYZ" }],
      ["extra-field", { unexpected: 1 }],
      ["missing-legal-name", { legal_name: undefined }],
      ["bad-settings", { settings: { fee_plan: "platinum" } }],
    ] as [string, Record<string, unknown>][]
  ).map(([name, patch]) =>
    scenario(`stations/validation/${name}`, async (c) => {
      await c.rstaff(name, "POST", "/internal/v1/stations", JSON.parse(JSON.stringify({ ...base, ...patch })));
    }),
  ),
  scenario("stations/list-search-filter-paginate", async (c) => {
    await c.createStation({ display_name: "Zara Cloud Kitchen" });
    await c.createStation();
    await c.createStation();
    await c.rstaff("search", "GET", "/internal/v1/stations?q=zara");
    await c.rstaff("filter verified", "GET", "/internal/v1/stations?kyc_status=verified");
    await c.rstaff("filter pending", "GET", "/internal/v1/stations?kyc_status=pending");
    const p = await c.rstaff("page 1", "GET", "/internal/v1/stations?limit=2");
    const last = (p.body as { data: { id: string }[] }).data[1]!.id;
    await c.rstaff("page 2", "GET", `/internal/v1/stations?limit=2&starting_after=${last}`);
  }),
  scenario("stations/bad-cursor-limit-and-unknown", async (c) => {
    await c.rstaff("bad cursor", "GET", "/internal/v1/stations?starting_after=pay_x");
    await c.rstaff("limit 0", "GET", "/internal/v1/stations?limit=0");
    await c.rstaff("limit 101", "GET", "/internal/v1/stations?limit=101");
    await c.rstaff("bad kyc filter", "GET", "/internal/v1/stations?kyc_status=maybe");
    await c.rstaff("unknown station", "GET", "/internal/v1/stations/mer_00000000000000000000000000");
    await c.rstaff("malformed id", "GET", "/internal/v1/stations/not-an-id");
  }),
  scenario("stations/kyc-verify-enables-live", async (c) => {
    const m = await c.merchant();
    await c.rstaff("live key before KYC", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "live" }, "security");
    await c.rstaff("verify", "POST", `/internal/v1/stations/${m.stationId}/kyc/verify`, undefined, "ops");
    await c.rstaff("live key after KYC", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "live" }, "security");
  }),
  scenario("stations/kyc-reject-reopen", async (c) => {
    const m = await c.merchant();
    const k = `/internal/v1/stations/${m.stationId}/kyc`;
    await c.rstaff("reject", "POST", `${k}/reject`, { reason: "PAN mismatch" }, "ops");
    await c.rstaff("verify rejected", "POST", `${k}/verify`, undefined, "ops");
    await c.rstaff("reopen", "POST", `${k}/reopen`, undefined, "ops");
    await c.rstaff("verify", "POST", `${k}/verify`, undefined, "ops");
    await c.rstaff("reopen verified", "POST", `${k}/reopen`, undefined, "ops");
    await c.rstaff("reject verified", "POST", `${k}/reject`, { reason: "too late" }, "ops");
    await c.rstaff("reject reason too short", "POST", `${k}/reject`, { reason: "x" }, "ops");
  }),
  scenario("stations/staff-settings", async (c) => {
    const m = await c.merchant();
    await c.rstaff(
      "finance updates",
      "PATCH",
      `/internal/v1/stations/${m.stationId}/settings`,
      { fee_plan: "enterprise", max_payment_amount: 5_000_000 },
      "finance",
    );
    await c.rstaff("audit", "GET", `/internal/v1/audit_log?target_id=${m.stationId}`);
  }),
  ...(
    [
      ["bad-plan", { fee_plan: "platinum" }],
      ["bad-schedule", { settlement_schedule: "T+0" }],
      ["zero-burst", { rate_limit_burst: 0 }],
      ["string-max-amount", { max_payment_amount: "100" }],
      ["webhook-http-remote", { webhook_url: "http://hooks.example/x" }],
    ] as [string, Record<string, unknown>][]
  ).map(([name, patch]) =>
    scenario(`stations/staff-settings-invalid/${name}`, async (c) => {
      const m = await c.merchant();
      await c.rstaff(name, "PATCH", `/internal/v1/stations/${m.stationId}/settings`, patch);
    }),
  ),
  scenario("stations/merchant-settings", async (c) => {
    const m = await c.merchant();
    await c.rcall("merchant updates", m, "PATCH", "/v1/station/settings", {
      webhook_url: "https://hooks.kaveri.example/mintrail",
      auto_capture: false,
    });
    await c.rcall("localhost allowed in dev/test", m, "PATCH", "/v1/station/settings", { webhook_url: "http://localhost:9000/hook" });
    await c.rcall("clear webhook", m, "PATCH", "/v1/station/settings", { webhook_url: null });
    await c.rcall("read back", m, "GET", "/v1/station");
  }),
  ...(
    [
      ["http-remote", { webhook_url: "http://hooks.example/x" }],
      ["ftp", { webhook_url: "ftp://x" }],
      ["fee-plan", { fee_plan: "growth" }],
    ] as [string, Record<string, unknown>][]
  ).map(([name, patch]) =>
    scenario(`stations/merchant-settings-denied/${name}`, async (c) => {
      const m = await c.merchant();
      await c.rcall(name, m, "PATCH", "/v1/station/settings", patch);
    }),
  ),
  scenario("stations/suspend-reactivate", async (c) => {
    const m = await c.merchant();
    await c.rstaff("suspend", "POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "fraud review" }, "security");
    await c.rcall("suspended merchant", m, "GET", "/v1/station");
    await c.rstaff("reactivate", "POST", `/internal/v1/stations/${m.stationId}/reactivate`, undefined, "security");
    await c.rcall("active again", m, "GET", "/v1/station");
  }),
];
