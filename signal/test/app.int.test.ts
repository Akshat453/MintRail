/** Signal service HTTP API (supertest). */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createSignalApp } from "../src/app.js";
import { openDb, testSettings, truncateAll } from "../../tests/support/db.js";

let conn: ReturnType<typeof openDb>;
beforeAll(() => {
  conn = openDb();
});
afterAll(() => conn.close());
beforeEach(() => truncateAll(conn.db));

const app = () => createSignalApp(testSettings({ signal_api_key: "test-signal-key" }), conn.db);

test("healthz and authenticated stats", async () => {
  expect((await request(app()).get("/healthz")).body).toEqual({ status: "ok", service: "signal" });
  expect((await request(app()).get("/internal/signal/v1/stats")).status).toBe(401);
  const r = await request(app()).get("/internal/signal/v1/stats").set("Authorization", "Bearer test-signal-key");
  expect(r.status).toBe(200);
  expect(r.text).toBe('{"object":"signal_stats","undispatched_events":0,"deliveries":{}}');
});

test("replay of an unknown delivery is a 404 in the MintRail error envelope", async () => {
  const r = await request(app())
    .post("/internal/signal/v1/deliveries/whd_01m7n9xhnpbya15q1vvjw7t7r7/replay")
    .set("Authorization", "Bearer test-signal-key");
  expect([r.status, r.body.error.code]).toEqual([404, "MR_WEBHOOK_DELIVERY_NOT_FOUND"]);
});
