/** Ported from junction/tests/test_bank_integration.py. */
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { jobs, parseJson, Worker } from "@mintrail/shared";

import { createApp } from "../src/app.js";
import { type AuthorizeRequest, Bank, BankError } from "../src/bank.js";
import { DeliveryFailedError, deliver, type Fetch } from "../src/callbacks.js";
import { buildRegistry } from "../src/worker.js";
import { openDb, testSettings, truncateAll } from "../../tests/support/db.js";

let conn: ReturnType<typeof openDb>;
beforeAll(() => {
  conn = openDb();
});
afterAll(() => conn.close());
beforeEach(() => truncateAll(conn.db));
const db = () => conn.db;
const settings = () => testSettings({ junction_callback_url: "http://platform.test/cb" });

const req = (extra: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  paymentId: "pay_1",
  merchantRef: "mer_1",
  amount: 10_000n,
  currency: "INR",
  method: "card",
  instrument: "card:411111:1111",
  livemode: false,
  scenario: "success",
  ...extra,
});

/** Stands in for Platform's callback endpoint. */
function recorder(status = 200): { events: Record<string, unknown>[]; fetch: Fetch } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    fetch: async (_url, init) => {
      expect(init.headers["Junction-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      events.push(parseJson(init.body) as Record<string, unknown>);
      return { status, text: async () => "" };
    },
  };
}

async function run(scenario: string, extra: Partial<AuthorizeRequest> = {}) {
  const rec = recorder();
  const [row, accepted] = await db().transaction((tx) => new Bank(tx, settings()).authorize(req({ scenario, ...extra })));
  expect(accepted).toBe(true);
  const worker = new Worker(db(), buildRegistry(settings(), rec.fetch as never), { queues: ["junction"], batchSize: 50 });
  while (await worker.runDue());
  const status = (await new Bank(db(), settings()).get(row.ref)).status;
  return { events: rec.events, status };
}

test("success card", async () => {
  const { events, status } = await run("success");
  expect(status).toBe("authorized");
  expect(events.map((e) => [e.type, e.sequence])).toEqual([["authorization.succeeded", 2n]]);
});

test("UPI sends pending first", async () => {
  const { events } = await run("success", { method: "upi", instrument: "upi:a@okaxis" });
  expect(events.map((e) => e.type)).toEqual(["authorization.pending", "authorization.succeeded"]);
});

test("decline", async () => {
  const { events, status } = await run("decline:expired_card");
  expect(status).toBe("declined");
  expect(events.at(-1)!.decline_code).toBe("expired_card");
  expect(events.at(-1)!.decline_reason).toBe("The card has expired");
});

test("timeout never resolves", async () => {
  expect(await run("timeout")).toEqual({ events: [], status: "pending" });
});

test("duplicates share the event id", async () => {
  const { events } = await run("duplicate_callbacks");
  expect(events).toHaveLength(3);
  expect(new Set(events.map((e) => e.id)).size).toBe(1);
});

test("out of order", async () => {
  expect((await run("out_of_order")).events.map((e) => e.sequence)).toEqual([2n, 1n]);
});

test("authorize is idempotent by payment", async () => {
  const bank = new Bank(db(), settings());
  const [a] = await bank.authorize(req());
  const [b] = await bank.authorize(req());
  expect(a.ref).toBe(b.ref);
  expect(b.requestsSeen).toBe(2);
  await expect(bank.authorize(req({ amount: 1n }))).rejects.toMatchObject({ status: 409 });
  expect(await db().select().from(jobs).where(eq(jobs.kind, "junction.decide"))).toHaveLength(1);
});

test("flaky rejects the first attempt", async () => {
  const bank = new Bank(db(), settings());
  let [row, accepted] = await bank.authorize(req({ scenario: "flaky" }));
  expect([accepted, row.status]).toEqual([false, "received"]);
  [row, accepted] = await bank.authorize(req({ scenario: "flaky" }));
  expect([accepted, row.status]).toEqual([true, "pending"]);
});

test("capture and void rules", async () => {
  const bank = new Bank(db(), settings());
  const [row] = await bank.authorize(req());
  await expect(bank.capture(row.ref, 10_000n)).rejects.toThrow(/pending/);
  await db().$client.query("UPDATE junction_authorizations SET status='authorized'");
  await expect(bank.capture(row.ref, 5_000n)).rejects.toMatchObject({ code: "amount_mismatch" });
  expect((await bank.capture(row.ref, 10_000n)).status).toBe("captured");
  expect((await bank.capture(row.ref, 10_000n)).status).toBe("captured");
  await expect(bank.void(row.ref)).rejects.toThrow(/refunded/);
  await expect(bank.get("JN000")).rejects.toThrow(BankError);
});

test("void pending stops resolution", async () => {
  const bank = new Bank(db(), settings());
  const [row] = await bank.authorize(req());
  await bank.void(row.ref);
  expect((await bank.void(row.ref)).status).toBe("voided");
  await bank.resolve(row.ref);
  expect((await bank.get(row.ref)).status).toBe("voided");
});

test("delivery failures raise", async () => {
  await expect(deliver(recorder(500).fetch, "http://p/cb", Buffer.from("s"), { id: "e" }, 1)).rejects.toThrow(DeliveryFailedError);
  const boom: Fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await expect(deliver(boom, "http://p/cb", Buffer.from("s"), {}, 1)).rejects.toThrow(/TypeError/);
});

describe("HTTP API", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(async () => {
    server = createApp(settings(), conn.db).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  const h = { Authorization: "Bearer test-junction-key" };
  const body = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      payment_id: "pay_http",
      merchant_ref: "mer_1",
      amount: 500,
      currency: "INR",
      method: "upi",
      instrument: "upi:a@okaxis",
      livemode: false,
      ...extra,
    });
  const call = async (method: string, path: string, b?: string, auth = true) => {
    const r = await fetch(base + path, { method, body: b, headers: { "Content-Type": "application/json", ...(auth ? h : {}) } });
    return { status: r.status, ct: r.headers.get("content-type"), body: parseJson(await r.text()) as Record<string, any> };
  };

  test("auth, health, content type", async () => {
    expect((await call("POST", "/v1/authorizations", body(), false)).status).toBe(401);
    const health = await call("GET", "/healthz");
    expect(health.body.service).toBe("junction");
    expect(health.ct).toBe("application/json");
  });

  test("lifecycle", async () => {
    const r = await call("POST", "/v1/authorizations", body());
    expect(r.status).toBe(202);
    const ref = r.body.ref as string;
    expect(ref).toMatch(/^JN\d{12}$/);
    expect((await call("GET", `/v1/authorizations/${ref}`)).body.status).toBe("pending");
    expect((await call("GET", "/v1/authorizations?payment_id=pay_http")).body.ref).toBe(ref);
    expect((await call("GET", "/v1/authorizations?payment_id=nope")).status).toBe(404);
    expect((await call("GET", "/v1/authorizations")).status).toBe(422);
    expect((await call("POST", `/v1/authorizations/${ref}/capture`, '{"amount": 500}')).status).toBe(409);
    expect((await call("POST", `/v1/authorizations/${ref}/void`)).body.status).toBe("voided");
    expect((await call("DELETE", `/v1/authorizations/${ref}`)).body).toEqual({ detail: "Method Not Allowed" });
    expect((await call("GET", "/nope")).body).toEqual({ detail: "Not Found" });
  });

  test("flaky 503 then accepted; unknown scenario 400", async () => {
    expect((await call("POST", "/v1/authorizations", body({ scenario: "flaky" }))).status).toBe(503);
    expect((await call("POST", "/v1/authorizations", body({ scenario: "flaky" }))).status).toBe(202);
    const r = await call("POST", "/v1/authorizations", body({ payment_id: "pay_2", scenario: "nope" }));
    expect([r.status, r.body.error.code]).toEqual([400, "unknown_scenario"]);
  });

  test("pydantic-compatible validation errors", async () => {
    const r = await call("POST", "/v1/authorizations", body({ amount: "500", currency: "EUR" }));
    expect(r.status).toBe(422);
    expect(r.body.detail).toEqual([
      { type: "int_type", loc: ["body", "amount"], msg: "Input should be a valid integer", input: "500" },
      {
        type: "literal_error",
        loc: ["body", "currency"],
        msg: "Input should be 'INR' or 'USD'",
        input: "EUR",
        ctx: { expected: "'INR' or 'USD'" },
      },
    ]);
    const z = await call("POST", "/v1/authorizations/JN000000000000/capture", '{"amount": 0}');
    expect(z.body.detail[0]).toMatchObject({ type: "greater_than", ctx: { gt: 0n } });
    const missing = await call("POST", "/v1/authorizations", "{}");
    expect(missing.body.detail[0]).toMatchObject({ type: "missing", loc: ["body", "payment_id"], msg: "Field required" });
    expect((await call("POST", "/v1/authorizations", "{not json")).status).toBe(422);
  });
});
