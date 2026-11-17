/**
 * The MintRail client.
 *
 *   const mr = new MintRail({ apiKey: process.env.MINTRAIL_API_KEY! });          // test key: Bearer
 *   const mr = new MintRail({ apiKey: liveSecret, keyId: "key_…" });             // live key: signed requests
 *
 * Every POST carries an ``Idempotency-Key`` (generated if you don't pass one) and
 * is retried with the *same* key on network errors, 409 "in progress", 429 and
 * 5xx — so a retry can never charge, refund or pay out twice.
 */
import { randomUUID } from "node:crypto";

import { verifyWebhookSignature } from "./crypto.js";
import { signRequest } from "./crypto.js";
import { parse, stringify } from "./json.js";
import type * as T from "./types.js";

export interface ClientOptions {
  apiKey: string;
  /** Required for live keys (``mr_live_…``): requests are signed with the key's derived signing key. */
  keyId?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test hook. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  idempotencyKey?: string;
  /** Test mode only: ``MintRail-Test-Scenario`` (e.g. ``success``, ``decline:insufficient_funds``, ``refund_fail``). */
  scenario?: string;
  headers?: Record<string, string>;
}

export class MintRailError extends Error {
  override name = "MintRailError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> | null,
  ) {
    super(`${code}: ${message}`);
  }
}

export class MintRailConnectionError extends Error {
  override name = "MintRailConnectionError";
}

const RETRYABLE_CODES = new Set(["MR_IDEMPOTENCY_KEY_IN_PROGRESS", "MR_RATE_LIMITED", "MR_SERVICE_UNAVAILABLE", "MR_GATEWAY_ERROR"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Query = Record<string, string | number | bigint | boolean | null | undefined>;

export class MintRail {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    if (!opts.apiKey?.startsWith("mr_test_") && !opts.apiKey?.startsWith("mr_live_"))
      throw new Error("apiKey must be an mr_test_… or mr_live_… key");
    if (opts.apiKey.startsWith("mr_live_") && !opts.keyId) throw new Error("live keys must sign requests: pass keyId (key_…)");
    this.baseUrl = (opts.baseUrl ?? "https://api.mintrail.example").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get livemode(): boolean {
    return this.opts.apiKey.startsWith("mr_live_");
  }

  // ---------------------------------------------------------------- transport
  async request<R>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    query?: Query,
    ro: RequestOptions = {},
  ): Promise<R> {
    const res = await this.raw(method, path, body === undefined ? undefined : stringify(body), query, ro, "application/json");
    return parse<R>(res.text);
  }

  /** Low-level call; returns the response text (also used for CSV downloads and multipart uploads). */
  async raw(
    method: string,
    path: string,
    body: string | FormData | undefined,
    query: Query | undefined,
    ro: RequestOptions,
    contentType?: string,
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) qs.set(k, String(v));
    const q = qs.toString();
    const idem = method === "POST" ? (ro.idempotencyKey ?? `sdk_${randomUUID()}`) : undefined;
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { "User-Agent": "mintrail-node/1.0.0", Accept: "application/json", ...(ro.headers ?? {}) };
      if (typeof body === "string" && contentType) headers["Content-Type"] = contentType;
      if (idem) headers["Idempotency-Key"] = idem;
      if (ro.scenario) headers["MintRail-Test-Scenario"] = ro.scenario;
      if (this.opts.keyId && this.livemode) {
        Object.assign(
          headers,
          signRequest(this.opts.apiKey, this.opts.keyId, {
            method,
            path,
            query: q,
            body: typeof body === "string" ? body : "",
            timestamp: Math.floor(Date.now() / 1000),
          }),
        );
      } else {
        headers.Authorization = `Bearer ${this.opts.apiKey}`;
      }
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}${q ? `?${q}` : ""}`, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new MintRailConnectionError(`could not reach MintRail: ${(e as Error).message}`);
      }
      const text = await res.text();
      if (res.status < 400) return { status: res.status, text, headers: res.headers };
      let err: { code?: string; message?: string; param?: string; request_id?: string; details?: Record<string, unknown> } = {};
      try {
        err = (parse<{ error?: typeof err }>(text).error ?? {}) as typeof err;
      } catch {
        /* not JSON */
      }
      const code = err.code ?? `HTTP_${res.status}`;
      if (attempt < maxRetries && (res.status >= 500 || res.status === 429 || RETRYABLE_CODES.has(code))) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt));
        continue;
      }
      throw new MintRailError(
        res.status,
        code,
        err.message ?? (text.slice(0, 200) || res.statusText),
        err.param ?? null,
        err.request_id ?? res.headers.get("x-request-id"),
        err.details ?? null,
      );
    }
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(8_000, 250 * 2 ** attempt);
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  /** Iterate every item of a list endpoint, following ``starting_after`` cursors. */
  async *paginate<I extends { id: string }, P extends T.ListParams>(
    list: (params: P) => Promise<T.List<I>>,
    params: P = {} as P,
  ): AsyncGenerator<I> {
    let cursor = params.starting_after;
    for (;;) {
      const page = await list({ ...params, starting_after: cursor });
      for (const item of page.data) yield item;
      if (!page.has_more || page.data.length === 0) return;
      cursor = page.data[page.data.length - 1]!.id;
    }
  }

  // ---------------------------------------------------------------- resources
  readonly station = {
    retrieve: () => this.request<T.Station>("GET", "/v1/station"),
    updateSettings: (settings: { webhook_url?: string | null; auto_capture?: boolean }) =>
      this.request<T.Station>("PATCH", "/v1/station/settings", settings),
  };

  readonly balance = {
    retrieve: (currency?: T.Currency) => this.request<T.Balance>("GET", "/v1/balance", undefined, { currency }),
  };

  readonly orders = {
    create: (p: { amount: bigint; currency?: T.Currency; receipt?: string; notes?: Record<string, string> }, ro?: RequestOptions) =>
      this.request<T.Order>("POST", "/v1/orders", p, undefined, ro),
    retrieve: (id: string) => this.request<T.Order>("GET", `/v1/orders/${id}`),
    list: (p: T.ListParams = {}) => this.request<T.List<T.Order>>("GET", "/v1/orders", undefined, { ...p }),
    payments: (id: string) => this.request<T.List<T.Payment>>("GET", `/v1/orders/${id}/payments`),
  };

  readonly payments = {
    create: (
      p: {
        order_id: string;
        method: "card" | "upi" | "netbanking";
        card?: { number: string; expiry_month: number; expiry_year: number; cvv: string; name?: string };
        upi?: { vpa: string };
        netbanking?: { bank_code: string };
        capture?: "automatic" | "manual";
        email?: string;
      },
      ro?: RequestOptions,
    ) => this.request<T.Payment>("POST", "/v1/payments", p, undefined, ro),
    retrieve: (id: string) => this.request<T.Payment>("GET", `/v1/payments/${id}`),
    list: (p: T.ListParams & { status?: T.PaymentStatus } = {}) =>
      this.request<T.List<T.Payment>>("GET", "/v1/payments", undefined, { ...p }),
    capture: (id: string, p: { amount?: bigint } = {}, ro?: RequestOptions) =>
      this.request<T.Payment>("POST", `/v1/payments/${id}/capture`, p, undefined, ro),
    refunds: (id: string) => this.request<T.List<T.Refund>>("GET", `/v1/payments/${id}/refunds`),
    /** Test mode: ask the simulated network to raise a chargeback on a captured payment. */
    simulateDispute: (id: string, p: { amount?: bigint; reason?: string; outcome?: "win" | "lose" } = {}, ro?: RequestOptions) =>
      this.request<{ object: "dispute_simulation"; network_reference: string; status: string }>(
        "POST",
        `/v1/payments/${id}/simulate_dispute`,
        p,
        undefined,
        ro,
      ),
  };

  readonly refunds = {
    create: (
      paymentId: string,
      p: {
        amount?: bigint;
        reason?: "requested_by_customer" | "duplicate" | "fraudulent" | "order_cancelled" | "other";
        speed?: "normal" | "instant";
        notes?: Record<string, string>;
      } = {},
      ro?: RequestOptions,
    ) => this.request<T.Refund>("POST", `/v1/payments/${paymentId}/refunds`, p, undefined, ro),
    retrieve: (id: string) => this.request<T.Refund>("GET", `/v1/refunds/${id}`),
    list: (p: T.ListParams & { payment_id?: string; status?: T.Refund["status"] } = {}) =>
      this.request<T.List<T.Refund>>("GET", "/v1/refunds", undefined, { ...p }),
  };

  readonly disputes = {
    retrieve: (id: string) => this.request<T.Dispute>("GET", `/v1/disputes/${id}`),
    list: (p: T.ListParams & { status?: T.Dispute["status"]; payment_id?: string } = {}) =>
      this.request<T.List<T.Dispute>>("GET", "/v1/disputes", undefined, { ...p }),
    /** Upload evidence files (PDF, PNG or JPEG) and/or a text statement. */
    addEvidence: async (
      id: string,
      p: { files?: { filename: string; content: Buffer; contentType?: string }[]; kind?: string; text?: string },
    ) => {
      const form = new FormData();
      for (const f of p.files ?? [])
        form.append("files", new Blob([new Uint8Array(f.content)], { type: f.contentType ?? "application/octet-stream" }), f.filename);
      if (p.kind) form.append("kind", p.kind);
      if (p.text) form.append("text", p.text);
      return parse<T.Dispute>((await this.raw("POST", `/v1/disputes/${id}/evidence`, form, undefined, {})).text);
    },
    submit: (id: string, ro?: RequestOptions) => this.request<T.Dispute>("POST", `/v1/disputes/${id}/submit`, undefined, undefined, ro),
    accept: (id: string, ro?: RequestOptions) => this.request<T.Dispute>("POST", `/v1/disputes/${id}/accept`, undefined, undefined, ro),
  };

  readonly payouts = {
    create: (
      p: {
        amount: bigint;
        mode: T.PayoutMode;
        purpose?: string;
        beneficiary: { name: string; account_number?: string; ifsc?: string; vpa?: string };
        reference?: string;
        narration?: string;
      },
      ro?: RequestOptions,
    ) => this.request<T.Payout>("POST", "/v1/payouts", p, undefined, ro),
    retrieve: (id: string) => this.request<T.Payout>("GET", `/v1/payouts/${id}`),
    list: (p: T.ListParams & { status?: T.Payout["status"]; batch_id?: string } = {}) =>
      this.request<T.List<T.Payout>>("GET", "/v1/payouts", undefined, { ...p }),
    cancel: (id: string, ro?: RequestOptions) => this.request<T.Payout>("POST", `/v1/payouts/${id}/cancel`, undefined, undefined, ro),
    /** Upload a bulk payout CSV (amounts in rupees). Returns the batch with per-row errors. */
    bulk: async (csv: string, filename = "payouts.csv") => {
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), filename);
      return parse<T.PayoutBatch>((await this.raw("POST", "/v1/payouts/bulk", form, undefined, {})).text);
    },
    batch: (id: string) => this.request<T.PayoutBatch>("GET", `/v1/payout_batches/${id}`),
  };

  readonly settlements = {
    retrieve: (id: string) => this.request<T.Settlement>("GET", `/v1/settlements/${id}`),
    list: (p: T.ListParams & { from?: string; to?: string; status?: T.Settlement["status"] } = {}) =>
      this.request<T.List<T.Settlement>>("GET", "/v1/settlements", undefined, { ...p }),
    entries: (id: string) => this.request<T.List<T.SettlementEntry>>("GET", `/v1/settlements/${id}/entries`),
    /** The settlement report as CSV text. */
    report: async (id: string) => (await this.raw("GET", `/v1/settlements/${id}/report`, undefined, undefined, {})).text,
  };

  readonly fxRates = {
    latest: (base: "USD" = "USD", quote: "INR" = "INR") => this.request<T.FxRate>("GET", "/v1/fx_rates/latest", undefined, { base, quote }),
  };

  readonly webhookEndpoints = {
    create: (p: { url: string; description?: string; enabled_events?: T.EventType[] | ["*"] }, ro?: RequestOptions) =>
      this.request<T.WebhookEndpoint>("POST", "/v1/webhook_endpoints", p, undefined, ro),
    list: () => this.request<T.List<T.WebhookEndpoint>>("GET", "/v1/webhook_endpoints"),
    retrieve: (id: string) => this.request<T.WebhookEndpoint>("GET", `/v1/webhook_endpoints/${id}`),
    update: (id: string, p: { url?: string; description?: string | null; enabled_events?: string[]; status?: "enabled" | "disabled" }) =>
      this.request<T.WebhookEndpoint>("PATCH", `/v1/webhook_endpoints/${id}`, p),
    delete: (id: string) => this.request<T.WebhookEndpoint>("DELETE", `/v1/webhook_endpoints/${id}`),
    rotateSecret: (id: string, ro?: RequestOptions) =>
      this.request<T.WebhookEndpoint>("POST", `/v1/webhook_endpoints/${id}/rotate_secret`, undefined, undefined, ro),
  };

  readonly webhookDeliveries = {
    list: (p: T.ListParams & { endpoint_id?: string; event_id?: string; status?: T.WebhookDelivery["status"] } = {}) =>
      this.request<T.List<T.WebhookDelivery>>("GET", "/v1/webhook_deliveries", undefined, { ...p }),
    retrieve: (id: string) => this.request<T.WebhookDelivery>("GET", `/v1/webhook_deliveries/${id}`),
    replay: (id: string, ro?: RequestOptions) =>
      this.request<T.WebhookDelivery>("POST", `/v1/webhook_deliveries/${id}/replay`, undefined, undefined, ro),
  };

  readonly events = {
    list: (p: T.ListParams & { type?: T.EventType } = {}) =>
      this.request<T.List<T.MintRailEvent>>("GET", "/v1/events", undefined, { ...p }),
    retrieve: (id: string) => this.request<T.MintRailEvent>("GET", `/v1/events/${id}`),
  };

  // ---------------------------------------------------------------- webhooks (receiving side)
  static readonly webhooks = {
    /** Verify ``MintRail-Signature`` over the *raw* body and return the parsed event. Throws WebhookSignatureError. */
    constructEvent<E = T.MintRailEvent>(
      rawBody: string | Buffer,
      signatureHeader: string,
      secret: string,
      opts: { toleranceS?: number; now?: number } = {},
    ): E {
      verifyWebhookSignature(rawBody, signatureHeader, secret, opts);
      return parse<E>(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    },
    verifySignature: verifyWebhookSignature,
  };
}
