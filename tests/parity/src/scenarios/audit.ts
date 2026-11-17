import { scenario } from "../scenario.js";

export default [
  scenario("audit/actions-recorded", async (c) => {
    const m = await c.merchant();
    await c.staff("POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "chargeback spike" });
    await c.rstaff("by target", "GET", `/internal/v1/audit_log?target_id=${m.stationId}`, undefined, "security");
    await c.rstaff("by staff", "GET", "/internal/v1/audit_log?staff_id=stf_00000000000000000000000004", undefined, "security");
  }),
  scenario("audit/failed-login-recorded", async (c) => {
    await c.api("POST", "/internal/v1/auth/login", { json: { email: "ghost@mintrail.example", password: "whatever-123" } });
    await c.rstaff("log", "GET", "/internal/v1/audit_log", undefined, "security");
  }),
  scenario("audit/pagination", async (c) => {
    for (let i = 0; i < 3; i++) await c.merchant();
    const p = await c.rstaff("page 1", "GET", "/internal/v1/audit_log?limit=2");
    const last = (p.body as { data: { id: number }[] }).data[1]!.id;
    await c.rstaff("page 2", "GET", `/internal/v1/audit_log?limit=50&starting_after=${last}`);
    await c.rstaff("bad limit", "GET", "/internal/v1/audit_log?limit=500");
    await c.rstaff("bad cursor", "GET", "/internal/v1/audit_log?starting_after=abc");
  }),
];
