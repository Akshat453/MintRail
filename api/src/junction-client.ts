/** Platform's HTTP client for Junction. Knows nothing of Junction's internals. */
import { parseJson, stringifyJson } from "@mintrail/shared";

/** Timeouts, connection errors and 5xx — safe to retry (requests are idempotent). */
export class JunctionUnavailableError extends Error {}

export class JunctionRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${status} ${code}: ${detail}`);
  }
}

export interface Authorization {
  ref: string;
  paymentId: string;
  status: string;
  declineCode: string | null;
  sequence: number;
}

export type Fetch = typeof fetch;

export class JunctionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 5000,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown; text: string }> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : stringifyJson(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      throw new JunctionUnavailableError(`${err.name}: ${err.message}`);
    }
    const text = await resp.text();
    if (resp.status >= 500) throw new JunctionUnavailableError(`junction answered ${resp.status}`);
    let data: unknown;
    try {
      data = text ? parseJson(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: resp.status, data, text };
  }

  private rejected(r: { status: number; data: unknown; text: string }): JunctionRejectedError {
    const err = ((r.data as { error?: Record<string, unknown> } | undefined)?.error ?? {}) as Record<string, unknown>;
    return new JunctionRejectedError(r.status, String(err.code ?? "unknown"), String(err.message ?? r.text));
  }

  private static of(data: unknown): Authorization {
    const d = data as Record<string, unknown>;
    return {
      ref: String(d.ref),
      paymentId: String(d.payment_id),
      status: String(d.status),
      declineCode: (d.decline_code as string | null) ?? null,
      sequence: Number(d.sequence ?? 0),
    };
  }

  async authorize(req: {
    paymentId: string;
    merchantRef: string;
    amount: bigint;
    currency: string;
    method: string;
    instrument: string;
    livemode: boolean;
    scenario: string | null;
  }): Promise<Authorization> {
    const r = await this.call("POST", "/v1/authorizations", {
      payment_id: req.paymentId,
      merchant_ref: req.merchantRef,
      amount: req.amount,
      currency: req.currency,
      method: req.method,
      instrument: req.instrument,
      livemode: req.livemode,
      scenario: req.scenario,
    });
    if (r.status >= 400) throw this.rejected(r);
    return JunctionClient.of(r.data);
  }

  async find(paymentId: string): Promise<Authorization | null> {
    const r = await this.call("GET", `/v1/authorizations?payment_id=${encodeURIComponent(paymentId)}`);
    if (r.status === 404) return null;
    if (r.status >= 400) throw this.rejected(r);
    return JunctionClient.of(r.data);
  }

  async capture(ref: string, amount: bigint): Promise<Authorization> {
    const r = await this.call("POST", `/v1/authorizations/${ref}/capture`, { amount });
    if (r.status >= 400) throw this.rejected(r);
    return JunctionClient.of(r.data);
  }

  async void(ref: string): Promise<Authorization> {
    const r = await this.call("POST", `/v1/authorizations/${ref}/void`);
    if (r.status >= 400) throw this.rejected(r);
    return JunctionClient.of(r.data);
  }

  // ---------------------------------------------------------------- M2
  private async json(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await this.call(method, path, body);
    if (r.status >= 400) throw this.rejected(r);
    return r.data as Record<string, unknown>;
  }

  refund(req: { refundId: string; authRef: string; amount: bigint; speed: string; scenario: string | null }) {
    return this.json("POST", "/v1/refunds", {
      refund_id: req.refundId,
      auth_ref: req.authRef,
      amount: req.amount,
      speed: req.speed,
      scenario: req.scenario,
    });
  }

  openDispute(req: { authRef: string; amount: bigint | null; reason: string; scenario: string | null }) {
    return this.json("POST", "/v1/disputes", { auth_ref: req.authRef, amount: req.amount, reason: req.reason, scenario: req.scenario });
  }

  submitDisputeEvidence(ref: string, documents: number) {
    return this.json("POST", `/v1/disputes/${ref}/evidence`, { documents: BigInt(documents) });
  }

  acceptDispute(ref: string) {
    return this.json("POST", `/v1/disputes/${ref}/accept`);
  }

  payout(req: { payoutId: string; amount: bigint; mode: string; destination: string; livemode: boolean; scenario: string | null }) {
    return this.json("POST", "/v1/payouts", {
      payout_id: req.payoutId,
      amount: req.amount,
      mode: req.mode,
      destination: req.destination,
      livemode: req.livemode,
      scenario: req.scenario,
    });
  }

  fxRate(base: string, quote: string, date: string) {
    return this.json("GET", `/v1/fx/${base}/${quote}?date=${encodeURIComponent(date)}`) as Promise<{
      rate: string;
      as_of: string;
      source: string;
    }>;
  }
}
