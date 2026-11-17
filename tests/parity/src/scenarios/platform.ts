import { scenario } from "../scenario.js";

export default [
  scenario("platform/healthz", async (c) => {
    await c.rapi("liveness", "GET", "/healthz");
    await c.rapi("readiness", "GET", "/readyz");
  }),
  scenario("platform/request-id-propagated", async (c) => {
    await c.rapi("inbound id kept", "GET", "/healthz", { headers: { "X-Request-Id": "trace-abc-12345" } });
  }),
  scenario("platform/request-id-hostile-replaced", async (c) => {
    await c.rapi("bad id replaced", "GET", "/healthz", { headers: { "X-Request-Id": "bad id" } });
  }),
  scenario("platform/unknown-route", async (c) => {
    await c.rapi("404 envelope", "GET", "/v1/nope");
  }),
  scenario("platform/method-not-allowed", async (c) => {
    await c.rapi("405 envelope", "DELETE", "/healthz");
  }),
];
