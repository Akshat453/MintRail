import { scenario } from "../scenario.js";

export default [
  scenario("keys/scoped-key", async (c) => {
    const m = await c.merchant();
    const r = await c.rstaff("issue read-only key", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, {
      scopes: ["orders:read"],
      label: "reporting",
    });
    const k = r.body as { id: string; secret: string };
    const ro = { stationId: m.stationId, keyId: k.id, secret: k.secret };
    await c.rcall("allowed read", ro, "GET", "/v1/orders");
    await c.rcall("denied write", ro, "POST", "/v1/orders", { amount: 1000 });
    await c.rcall("denied station read", ro, "GET", "/v1/station");
    await c.rcall("denied balance", ro, "GET", "/v1/balance");
  }),
  scenario("keys/scope-normalisation", async (c) => {
    const m = await c.merchant();
    const p = `/internal/v1/stations/${m.stationId}/api_keys`;
    await c.rstaff("dedupe and sort", "POST", p, { scopes: ["payments:read", "orders:read", "orders:read"] });
    await c.rstaff("wildcard wins", "POST", p, { scopes: ["orders:read", "*"] });
    await c.rstaff("unknown scope", "POST", p, { scopes: ["refunds:write"] });
  }),
  scenario("keys/list-hides-secret", async (c) => {
    const m = await c.merchant();
    await c.rstaff("list", "GET", `/internal/v1/stations/${m.stationId}/api_keys`);
  }),
  scenario("keys/revoke", async (c) => {
    const m = await c.merchant();
    await c.rstaff("revoke", "POST", `/internal/v1/api_keys/${m.keyId}/revoke`, undefined, "security");
    await c.rstaff("revoke again", "POST", `/internal/v1/api_keys/${m.keyId}/revoke`, undefined, "security");
    await c.rcall("revoked bearer", m, "GET", "/v1/station");
    await c.rstaff("revoke unknown", "POST", "/internal/v1/api_keys/key_00000000000000000000000000/revoke");
  }),
  scenario("keys/limit", async (c) => {
    const m = await c.merchant();
    for (let i = 0; i < 5; i++) {
      await c.rstaff(`issue ${i + 2}`, "POST", `/internal/v1/stations/${m.stationId}/api_keys`, {});
    }
  }),
  scenario("keys/create-validation", async (c) => {
    const m = await c.merchant();
    await c.rstaff("bad mode", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "prod" });
    await c.rstaff("extra field", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, { colour: "red" });
  }),
];
