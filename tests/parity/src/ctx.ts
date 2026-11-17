/** Scenario context: helpers that mirror the M1 test harness, plus recording. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { cfg, STAFF_PASSWORD } from "./config.js";
import { pool, quiesce, type Role, snapshot, snapshotM2, sql, staffEmail } from "./db.js";
import { nowSeconds, type Resp, send, signCallback, signHeaders, toJson } from "./http.js";
import { Normalizer, sortRows } from "./normalize.js";

export interface Merchant {
  stationId: string;
  keyId: string;
  secret: string;
}

export interface CallOptions {
  signed?: boolean;
  /** `undefined` → auto-generated deterministic key; `null` → header omitted. */
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  timestamp?: number;
  raw?: string;
}

interface Step {
  step: string;
  request: { method: string; path: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const RECORDED_HEADERS = [
  "content-type",
  "idempotent-replayed",
  "mintrail-version",
  "ratelimit-limit",
  "retry-after",
  "www-authenticate",
  "x-request-id",
];

export const TEST_CARD = { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" };

export class Ctx {
  readonly steps: Step[] = [];
  readonly notes: Record<string, unknown> = {};
  /** Record exact RateLimit-Remaining values (only deterministic in rate-limit scenarios). */
  recordRemaining = false;
  private idem = 0;
  private stationN = 0;
  private readonly tokens = new Map<Role, string>();

  // ---------------------------------------------------------------- recording
  record(step: string, method: string, path: string, resp: Resp, body?: unknown): Resp {
    const headers: Record<string, string> = {};
    for (const h of RECORDED_HEADERS) {
      if (resp.headers[h] !== undefined) headers[h] = resp.headers[h];
    }
    if (resp.headers["ratelimit-remaining"] !== undefined) {
      headers["ratelimit-remaining"] = this.recordRemaining ? resp.headers["ratelimit-remaining"] : "<present>";
    }
    this.steps.push({
      step,
      request: body === undefined ? { method, path } : { method, path, body },
      status: resp.status,
      headers,
      body: resp.body,
    });
    return resp;
  }

  /** Recorded variants of the helpers below. */
  async rapi(step: string, method: string, path: string, opts: Parameters<typeof send>[3] = {}): Promise<Resp> {
    return this.record(step, method, path, await this.api(method, path, opts), opts.json ?? opts.raw);
  }

  async rstaff(step: string, method: string, path: string, json?: unknown, role: Role = "admin"): Promise<Resp> {
    return this.record(step, method, path, await this.staff(method, path, json, role), json);
  }

  async rcall(step: string, m: Merchant, method: string, path: string, payload?: unknown, opts: CallOptions = {}): Promise<Resp> {
    return this.record(step, method, path, await this.call(m, method, path, payload, opts), payload);
  }

  async rjunction(step: string, method: string, path: string, json?: unknown, auth = true): Promise<Resp> {
    return this.record(step, method, `junction:${path}`, await this.junction(method, path, json, auth), json);
  }

  note(key: string, value: unknown): void {
    this.notes[key] = value;
  }

  async finish(m2 = false): Promise<unknown> {
    await quiesce();
    await Promise.all(this.receivers.map((r) => new Promise((done) => r.close(done))));
    const n = new Normalizer();
    const steps = n.value(this.steps);
    const notes = n.value(this.notes);
    const raw = { ...(await snapshot()), ...(m2 ? await snapshotM2() : {}) };
    n.frozen = true;
    const db: Record<string, unknown> = {};
    for (const [table, rows] of Object.entries(raw)) {
      const normalized = rows.map((r) => n.value(r));
      if (table === "staff_audit_log" || table === "derailment_notes") {
        db[table] = normalized; // chronological; the harness is serial
      } else if (table === "payment_events") {
        const groups: Record<string, unknown[]> = {};
        for (const row of normalized as Record<string, unknown>[]) {
          const key = String(row.payment_id);
          (groups[key] ??= []).push(row);
        }
        db[table] = n.value(groups);
      } else {
        db[table] = sortRows(normalized);
      }
    }
    return { steps, notes, db };
  }

  // ---------------------------------------------------------------- M2 helpers
  private readonly receivers: Server[] = [];

  /** A webhook receiver on this host; Signal (in Docker) reaches it via ``cfg.receiverHost``. */
  async receiver(status = 200): Promise<{ url: string; got: { type: string; signed: boolean }[] }> {
    const got: { type: string; signed: boolean }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push({
          type: String(req.headers["mintrail-event-type"]),
          signed: /^t=\d+,v1=[0-9a-f]{64}/.test(String(req.headers["mintrail-signature"] ?? "")),
        });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    this.receivers.push(server);
    return { url: `http://${cfg.receiverHost}:${(server.address() as AddressInfo).port}/parity-hook`, got };
  }

  /** multipart/form-data upload as a merchant (test key, Bearer). */
  async upload(m: Merchant, path: string, files: [string, Buffer, string][], fields: Record<string, string> = {}): Promise<Resp> {
    const form = new FormData();
    for (const [name, buf, type] of files)
      form.append(name.endsWith(".csv") ? "file" : "files", new Blob([new Uint8Array(buf)], { type }), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(cfg.apiUrl + path, { method: "POST", headers: { Authorization: `Bearer ${m.secret}` }, body: form });
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => (out[k] = v));
    return {
      status: res.status,
      headers: out,
      body: (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : text,
      text,
    };
  }

  async rupload(
    step: string,
    m: Merchant,
    path: string,
    files: [string, Buffer, string][],
    fields: Record<string, string> = {},
  ): Promise<Resp> {
    return this.record(step, "POST", path, await this.upload(m, path, files, fields), {
      files: files.map(([n, b, t]) => ({ name: n, bytes: b.length, type: t })),
      fields,
    });
  }

  /** Depot's internal API (service token). */
  async rdepot(step: string, path: string, json?: unknown): Promise<Resp> {
    return this.record(
      step,
      "POST",
      `depot:${path}`,
      await send(cfg.depotUrl, "POST", path, { json: json ?? {}, headers: { Authorization: `Bearer ${cfg.depotApiKey}` } }),
      json,
    );
  }

  /** IST business date ``days`` from today. */
  istDate(days = 0): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + days * 86_400_000));
  }

  /** Dashboard session headers for a new user of ``stationId``. */
  async dashboard(stationId: string, role = "owner", mode: "test" | "live" = "test"): Promise<Record<string, string>> {
    this.idem += 1;
    const email = `${role}-${this.idem}@merchant.parity.example`;
    await this.staff("POST", `/internal/v1/stations/${stationId}/dashboard_users`, {
      email,
      full_name: `Parity ${role}`,
      role,
      password: STAFF_PASSWORD,
    });
    const r = await this.api("POST", "/dashboard/v1/auth/login", { json: { email, password: STAFF_PASSWORD } });
    return { Authorization: `Bearer ${(r.body as { token: string }).token}`, "MintRail-Mode": mode };
  }

  async rdash(step: string, headers: Record<string, string>, method: string, path: string, json?: unknown): Promise<Resp> {
    const h = { ...headers };
    if (method === "POST") {
      this.idem += 1;
      h["Idempotency-Key"] = `parity-dash-${this.idem}`;
    }
    return this.record(step, method, path, await this.api(method, path, { json, headers: h }), json);
  }

  // ---------------------------------------------------------------- raw access
  api(method: string, path: string, opts: Parameters<typeof send>[3] = {}): Promise<Resp> {
    return send(cfg.apiUrl, method, path, opts);
  }

  async junction(method: string, path: string, json?: unknown, auth = true): Promise<Resp> {
    return send(cfg.junctionUrl, method, path, {
      json,
      headers: auth ? { Authorization: `Bearer ${cfg.junctionApiKey}` } : {},
    });
  }

  sql = sql;
  settle = quiesce;

  async releaseJobs(kind?: string): Promise<void> {
    await sql(`UPDATE jobs SET run_at = now() WHERE status = 'queued'${kind ? " AND kind = $1" : ""}`, kind ? [kind] : []);
  }

  async agePayment(paymentId: string, seconds: number): Promise<void> {
    await sql("UPDATE payments SET created_at = created_at - make_interval(secs => $1) WHERE id = $2", [seconds, paymentId]);
  }

  async postCallback(
    event: Record<string, unknown>,
    opts: { secret?: string; ts?: number; signature?: string | null } = {},
  ): Promise<Resp> {
    const body = toJson(event);
    const headers: Record<string, string> = {};
    if (opts.signature !== null) {
      headers["Junction-Signature"] = opts.signature ?? signCallback(opts.secret ?? cfg.callbackSecret, opts.ts ?? nowSeconds(), body);
    }
    return this.api("POST", "/internal/junction/v1/callbacks", { raw: body, headers });
  }

  // ---------------------------------------------------------------- staff
  async staffHeaders(role: Role = "admin"): Promise<Record<string, string>> {
    let token = this.tokens.get(role);
    if (!token) {
      const r = await this.api("POST", "/internal/v1/auth/login", {
        json: { email: staffEmail(role), password: STAFF_PASSWORD },
      });
      if (r.status !== 200) throw new Error(`staff login failed: ${r.status} ${r.text}`);
      token = (r.body as { token: string }).token;
      this.tokens.set(role, token);
    }
    return { Authorization: `Bearer ${token}` };
  }

  async staff(method: string, path: string, json?: unknown, role: Role = "admin"): Promise<Resp> {
    return this.api(method, path, { json, headers: await this.staffHeaders(role) });
  }

  // ---------------------------------------------------------------- stations
  async createStation(overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
    this.stationN += 1;
    const n = this.stationN;
    const body = {
      legal_name: `Kaveri Coffee Roasters ${n} Pvt Ltd`,
      display_name: `Kaveri Coffee ${n}`,
      email: `finance-${n}@kaveri.example`,
      business_category: "5814",
      ...overrides,
    };
    const r = await this.staff("POST", "/internal/v1/stations", body);
    if (r.status !== 201) throw new Error(`station create failed: ${r.status} ${r.text}`);
    return r.body as Record<string, any>;
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
    const k = r.body as { id: string; secret: string };
    return { stationId: m.stationId, keyId: k.id, secret: k.secret };
  }

  async testKeyFor(stationId: string): Promise<Merchant> {
    const r = await this.staff("POST", `/internal/v1/stations/${stationId}/api_keys`, {});
    const k = r.body as { id: string; secret: string };
    return { stationId, keyId: k.id, secret: k.secret };
  }

  // ---------------------------------------------------------------- merchant calls
  async call(m: Merchant, method: string, path: string, payload?: unknown, opts: CallOptions = {}): Promise<Resp> {
    const body = opts.raw ?? (payload === undefined ? "" : toJson(payload));
    const headers: Record<string, string> = {};
    if (body !== "") headers["Content-Type"] = "application/json";
    if (method === "POST") {
      if (opts.idempotencyKey === undefined) {
        this.idem += 1;
        headers["Idempotency-Key"] = `parity-${this.idem}`;
      } else if (opts.idempotencyKey !== null) {
        headers["Idempotency-Key"] = opts.idempotencyKey;
      }
    }
    if (opts.signed) {
      Object.assign(headers, signHeaders(m.secret, m.keyId, method, path, body, opts.timestamp ?? nowSeconds()));
    } else {
      headers.Authorization = `Bearer ${m.secret}`;
    }
    Object.assign(headers, opts.headers ?? {});
    return this.api(method, path, { raw: body === "" ? undefined : body, headers });
  }

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
    const payload: Record<string, unknown> = { order_id: orderId, method, ...(opts.extra ?? {}) };
    const defaults = {
      upi: { upi: { vpa: "success@mintrail" } },
      card: { card: TEST_CARD },
      netbanking: { netbanking: { bank_code: "MRTEST" } },
    };
    Object.assign(payload, opts.details ?? defaults[method]);
    const headers = opts.scenario ? { "MintRail-Test-Scenario": opts.scenario } : undefined;
    return this.call(m, "POST", "/v1/payments", payload, { headers });
  }

  /** Create an order, pay, wait for the workers, return the final payment. */
  async paid(
    m: Merchant,
    method: "upi" | "card" | "netbanking" = "upi",
    opts: Parameters<Ctx["pay"]>[3] & { amount?: bigint } = {},
  ): Promise<any> {
    const o = await this.order(m, opts.amount ?? 49_900n);
    const r = await this.pay(m, o.id, method, opts);
    if (r.status !== 201) throw new Error(`pay failed: ${r.status} ${r.text}`);
    await this.settle();
    return (await this.call(m, "GET", `/v1/payments/${(r.body as { id: string }).id}`)).body;
  }

  async internalPayment(id: string): Promise<any> {
    return (await this.staff("GET", `/internal/v1/payments/${id}`)).body;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
