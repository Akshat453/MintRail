/**
 * Test harness: Platform + Junction as real HTTP servers on ephemeral ports,
 * plus both workers, against one database. Junction delivers signed callbacks
 * to the Platform server; ``drain()`` runs both workers until idle.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { sql } from "drizzle-orm";

import { type Db, hashPassword, type Settings, stringifyJson, parseJson, Worker } from "@mintrail/shared";
import { SignalEngine, signalOptions } from "@mintrail/signal";

import { createApp } from "./app.js";
import { JunctionClient } from "./junction-client.js";
import type { StaffRole } from "./schema/index.js";
import { StaffService } from "./services/staff.js";
import { signRequest } from "./signing.js";
import { buildRegistry as paymentsRegistry } from "./worker.js";

export const STAFF_PASSWORD = "correct-horse-battery-staple";

export interface Merchant {
  stationId: string;
  keyId: string;
  secret: string;
}

export interface Resp {
  status: number;
  headers: Record<string, string>;
  // biome-ignore lint: JSON bodies in tests
  body: any;
  text: string;
}

const listen = (app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<Server> =>
  new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

export class Harness {
  platformUrl = "";
  junctionUrl = "";
  settings!: Settings;
  paymentsWorker!: Worker;
  junctionWorker!: Worker;
  signal!: SignalEngine;
  private servers: Server[] = [];
  private tokens = new Map<StaffRole, string>();
  private idem = 0;

  private constructor(
    readonly db: Db,
    private readonly base: Settings,
  ) {}

  static async start(
    db: Db,
    settings: Settings,
    createJunctionApp: (s: Settings, db: Db) => { listen: (port: number, host: string, cb: () => void) => Server },
    junctionRegistry: (s: Settings, f: typeof fetch) => ConstructorParameters<typeof Worker>[1],
  ): Promise<Harness> {
    const h = new Harness(db, settings);
    const junctionServer = await listen(createJunctionApp(settings, db));
    h.junctionUrl = urlOf(junctionServer);
    // Platform needs Junction's URL; Junction needs Platform's callback URL — start Platform second.
    const junction = new JunctionClient(h.junctionUrl, settings.junction_api_key, settings.junction_timeout_s * 1000);
    const platformServer = await listen(createApp({ settings: { ...settings, junction_url: h.junctionUrl }, db, junction }));
    h.platformUrl = urlOf(platformServer);
    h.settings = { ...settings, junction_url: h.junctionUrl, junction_callback_url: `${h.platformUrl}/internal/junction/v1/callbacks` };
    h.servers = [junctionServer, platformServer];
    h.paymentsWorker = new Worker(db, paymentsRegistry(h.settings, junction), {
      queues: ["payments"],
      workerId: "test-payments-worker",
      batchSize: 50,
    });
    h.junctionWorker = new Worker(db, junctionRegistry(h.settings, fetch), {
      queues: ["junction"],
      workerId: "test-junction-worker",
      batchSize: 50,
    });
    h.signal = new SignalEngine(db, signalOptions(h.settings));
    return h;
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(r))));
    await this.signal.close();
  }

  /** Payments + Junction workers and Signal (fan-out + deliveries) until everything is idle. */
  async drainAll(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const n = (await this.drain()) + (await this.signal.drain());
      if (n === 0) return;
    }
    throw new Error("workers did not go idle");
  }

  // ------------------------------------------------------------ dashboard
  async dashboardLogin(stationId: string, role = "owner", mode: "test" | "live" = "test"): Promise<Record<string, string>> {
    const email = `${role}-${Math.random().toString(36).slice(2, 10)}@merchant.example`;
    const r = await this.staff("POST", `/internal/v1/stations/${stationId}/dashboard_users`, {
      email,
      full_name: `Dash ${role}`,
      role,
      password: STAFF_PASSWORD,
    });
    if (r.status !== 201) throw new Error(`dashboard user create failed: ${r.text}`);
    const l = await this.request("POST", "/dashboard/v1/auth/login", { json: { email, password: STAFF_PASSWORD } });
    if (l.status !== 200) throw new Error(`dashboard login failed: ${l.text}`);
    return { Authorization: `Bearer ${l.body.token as string}`, "MintRail-Mode": mode };
  }

  async dash(
    headers: Record<string, string>,
    method: string,
    path: string,
    json?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Resp> {
    const h: Record<string, string> = { ...headers, ...extra };
    if (method === "POST" && !("Idempotency-Key" in h)) h["Idempotency-Key"] = `dash-${++this.idem}-${Math.random().toString(36).slice(2)}`;
    return this.request(method, path, { json, headers: h });
  }

  // ------------------------------------------------------------ workers
  async drain(maxRounds = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = (await this.paymentsWorker.runDue()) + (await this.junctionWorker.runDue());
      total += n;
      if (n === 0) return total;
    }
    throw new Error("workers did not go idle");
  }

  async releaseJobs(kind?: string): Promise<void> {
    await this.db.execute(
      kind
        ? sql`UPDATE jobs SET run_at = now() WHERE status = 'queued' AND kind = ${kind}`
        : sql`UPDATE jobs SET run_at = now() WHERE status = 'queued'`,
    );
  }

  async agePayment(paymentId: string, seconds: number): Promise<void> {
    await this.db.execute(sql`UPDATE payments SET created_at = created_at - make_interval(secs => ${seconds}) WHERE id = ${paymentId}`);
  }

  // ------------------------------------------------------------ http
  async request(
    method: string,
    path: string,
    opts: { json?: unknown; raw?: string | Buffer; headers?: Record<string, string>; base?: string } = {},
  ): Promise<Resp> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | Buffer | undefined = opts.raw;
    if (body === undefined && opts.json !== undefined) body = stringifyJson(opts.json);
    if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/json";
    const res = await fetch((opts.base ?? this.platformUrl) + path, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    let parsed: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json") && text) parsed = parseJson(text);
    return { status: res.status, headers: out, body: parsed, text };
  }

  // ------------------------------------------------------------ staff
  async staffHeaders(role: StaffRole = "admin"): Promise<Record<string, string>> {
    let token = this.tokens.get(role);
    if (!token) {
      const email = `${role}-${Math.random().toString(36).slice(2, 10)}@mintrail.example`;
      await this.db.transaction((tx) =>
        new StaffService(tx, this.settings).createStaff({ email, fullName: `Test ${role}`, role, password: STAFF_PASSWORD }),
      );
      const r = await this.request("POST", "/internal/v1/auth/login", { json: { email, password: STAFF_PASSWORD } });
      if (r.status !== 200) throw new Error(`staff login failed: ${r.text}`);
      token = r.body.token as string;
      this.tokens.set(role, token);
    }
    return { Authorization: `Bearer ${token}` };
  }

  async staff(method: string, path: string, json?: unknown, role: StaffRole = "admin"): Promise<Resp> {
    return this.request(method, path, { json, headers: await this.staffHeaders(role) });
  }

  // ------------------------------------------------------------ stations
  // biome-ignore lint: JSON
  async createStation(overrides: Record<string, unknown> = {}): Promise<any> {
    const n = Math.random().toString(36).slice(2, 10);
    const r = await this.staff("POST", "/internal/v1/stations", {
      legal_name: `Kaveri Coffee Roasters ${n} Pvt Ltd`,
      display_name: `Kaveri Coffee ${n}`,
      email: `finance-${n}@kaveri.example`,
      business_category: "5814",
      ...overrides,
    });
    if (r.status !== 201) throw new Error(`station create failed: ${r.status} ${r.text}`);
    return r.body;
  }

  async merchant(overrides: Record<string, unknown> = {}): Promise<Merchant> {
    const d = await this.createStation(overrides);
    return { stationId: d.station.id, keyId: d.test_api_key.id, secret: d.test_api_key.secret };
  }

  async liveMerchant(): Promise<Merchant> {
    const m = await this.merchant();
    let r = await this.staff("POST", `/internal/v1/stations/${m.stationId}/kyc/verify`);
    if (r.status !== 200) throw new Error(r.text);
    r = await this.staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "live" });
    if (r.status !== 201) throw new Error(r.text);
    return { stationId: m.stationId, keyId: r.body.id, secret: r.body.secret };
  }

  async call(
    m: Merchant,
    method: string,
    path: string,
    payload?: unknown,
    opts: { signed?: boolean; idempotencyKey?: string | null; headers?: Record<string, string>; timestamp?: number; raw?: string } = {},
  ): Promise<Resp> {
    const body = opts.raw ?? (payload === undefined ? "" : stringifyJson(payload));
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (method === "POST") {
      if (opts.idempotencyKey === undefined) headers["Idempotency-Key"] = `test-${++this.idem}-${Math.random().toString(36).slice(2)}`;
      else if (opts.idempotencyKey !== null) headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    if (opts.signed) {
      const [p, q = ""] = path.split("?", 2) as [string, string?];
      Object.assign(headers, signRequest(m.secret, m.keyId, { method, path: p, query: q, body, timestamp: opts.timestamp }));
    } else {
      headers.Authorization = `Bearer ${m.secret}`;
    }
    Object.assign(headers, opts.headers ?? {});
    return this.request(method, path, { raw: body || undefined, headers });
  }

  // biome-ignore lint: JSON
  async order(m: Merchant, amount = 49_900n, extra: Record<string, unknown> = {}): Promise<any> {
    const r = await this.call(m, "POST", "/v1/orders", { amount, currency: "INR", ...extra });
    if (r.status !== 201) throw new Error(`order failed: ${r.status} ${r.text}`);
    return r.body;
  }

  async pay(
    m: Merchant,
    orderId: string,
    method: "upi" | "card" | "netbanking" = "upi",
    opts: { scenario?: string; details?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
  ): Promise<Resp> {
    const defaults = {
      upi: { upi: { vpa: "success@mintrail" } },
      card: { card: { number: "4111111111111111", expiry_month: 12n, expiry_year: 2030n, cvv: "123" } },
      netbanking: { netbanking: { bank_code: "MRTEST" } },
    };
    const payload = { order_id: orderId, method, ...(opts.details ?? defaults[method]), ...(opts.extra ?? {}) };
    return this.call(m, "POST", "/v1/payments", payload, { headers: opts.scenario ? { "MintRail-Test-Scenario": opts.scenario } : {} });
  }

  // biome-ignore lint: JSON
  async payment(m: Merchant, id: string): Promise<any> {
    const r = await this.call(m, "GET", `/v1/payments/${id}`);
    if (r.status !== 200) throw new Error(r.text);
    return r.body;
  }

  // biome-ignore lint: JSON
  async paid(
    m: Merchant,
    method: "upi" | "card" | "netbanking" = "upi",
    opts: Parameters<Harness["pay"]>[3] & { amount?: bigint } = {},
  ): Promise<any> {
    const o = await this.order(m, opts.amount ?? 49_900n);
    const r = await this.pay(m, o.id, method, opts);
    if (r.status !== 201) throw new Error(`pay failed: ${r.status} ${r.text}`);
    await this.drain();
    return this.payment(m, r.body.id);
  }

  // biome-ignore lint: JSON
  async internalPayment(id: string): Promise<any> {
    return (await this.staff("GET", `/internal/v1/payments/${id}`)).body;
  }
}

export { hashPassword };
