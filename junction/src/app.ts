/** Junction's HTTP API (what Platform calls). Base URL: ``MINTRAIL_JUNCTION_URL``. */
import express, { type NextFunction, type Request, type Response } from "express";

import { apiTime, constantTimeEqual, type Db, parseJson, type Settings, stringifyJson } from "@mintrail/shared";

import { z } from "zod";

import { Bank, BankError } from "./bank.js";
import { BankOps, simulatedUsdInr } from "./ops.js";
import { AUTHORIZE_FIELDS, CAPTURE_FIELDS, type PydErr, validateModel } from "./pydantic.js";
import { UnknownScenarioError } from "./scenarios.js";
import type { JunctionAuthorization } from "./schema.js";

const send = (res: Response, status: number, body: unknown): void => {
  // setHeader, not res.set(): Express would append "; charset=utf-8" (M1 sent plain application/json).
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(Buffer.from(stringifyJson(body)));
};

const out = (row: JunctionAuthorization) => ({
  ref: row.ref,
  payment_id: row.paymentId,
  status: row.status,
  amount: row.amount,
  currency: row.currency,
  decline_code: row.declineCode,
  sequence: row.sequence,
  created_at: apiTime(row.createdAt),
});

class ValidationFailure extends Error {
  constructor(readonly detail: PydErr[]) {
    super("validation failed");
  }
}

export function createApp(settings: Settings, db: Db): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.text({ type: () => true, limit: "1mb" }));

  const body = (req: Request): unknown => {
    const raw = typeof req.body === "string" ? req.body : "";
    try {
      return raw.length > 0 ? parseJson(raw) : undefined;
    } catch {
      throw new ValidationFailure([
        { type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {}, ctx: { error: "Expecting value" } },
      ]);
    }
  };

  const auth = (req: Request, _res: Response, next: NextFunction): void => {
    const expected = `Bearer ${settings.junction_api_key}`;
    const got = req.get("authorization");
    if (got === undefined || !constantTimeEqual(got, expected)) {
      next(new BankError("unauthorized", "invalid Junction API key", 401));
      return;
    }
    next();
  };

  const withTx = <T>(fn: (bank: Bank) => Promise<T>): Promise<T> => db.transaction((tx) => fn(new Bank(tx, settings)));

  app.get("/healthz", (_req, res) => send(res, 200, { status: "ok", service: "junction" }));

  app.post("/v1/authorizations", auth, async (req, res) => {
    const { value, errors } = validateModel(body(req), AUTHORIZE_FIELDS);
    if (errors.length) throw new ValidationFailure(errors);
    let result: [JunctionAuthorization, boolean];
    try {
      result = await withTx((bank) =>
        bank.authorize({
          paymentId: value.payment_id as string,
          merchantRef: value.merchant_ref as string,
          amount: value.amount as bigint,
          currency: value.currency as string,
          method: value.method as string,
          instrument: value.instrument as string,
          livemode: value.livemode as boolean,
          scenario: (value.scenario as string | null) ?? null,
        }),
      );
    } catch (e) {
      if (e instanceof UnknownScenarioError) throw new BankError("unknown_scenario", e.message, 400);
      throw e;
    }
    const [row, accepted] = result;
    if (!accepted) {
      send(res, 503, { error: { code: "unavailable", message: "issuer switch unavailable" } });
      return;
    }
    send(res, 202, out(row));
  });

  app.get("/v1/authorizations", auth, async (req, res) => {
    const paymentId = typeof req.query.payment_id === "string" ? req.query.payment_id : undefined;
    if (paymentId === undefined) {
      throw new ValidationFailure([{ type: "missing", loc: ["query", "payment_id"], msg: "Field required", input: null }]);
    }
    if (paymentId.length < 1) {
      throw new ValidationFailure([
        {
          type: "string_too_short",
          loc: ["query", "payment_id"],
          msg: "String should have at least 1 character",
          input: paymentId,
          ctx: { min_length: 1 },
        },
      ]);
    }
    const row = await withTx((bank) => bank.findByPayment(paymentId));
    if (!row) throw new BankError("not_found", `no authorization for ${paymentId}`, 404);
    send(res, 200, out(row));
  });

  app.get("/v1/authorizations/:ref", auth, async (req, res) => {
    send(res, 200, out(await withTx((bank) => bank.get(req.params.ref as string))));
  });

  app.post("/v1/authorizations/:ref/capture", auth, async (req, res) => {
    const { value, errors } = validateModel(body(req), CAPTURE_FIELDS);
    if (errors.length) throw new ValidationFailure(errors);
    send(res, 200, out(await withTx((bank) => bank.capture(req.params.ref as string, value.amount as bigint))));
  });

  app.post("/v1/authorizations/:ref/void", auth, async (req, res) => {
    send(res, 200, out(await withTx((bank) => bank.void(req.params.ref as string))));
  });

  // ---------------------------------------------------------------- M2: refunds, disputes, payouts, FX
  const withOps = <T>(fn: (ops: BankOps) => Promise<T>): Promise<T> => db.transaction((tx) => fn(new BankOps(tx, settings)));
  const parse = <S extends z.ZodType>(schema: S, req: Request): z.output<S> => {
    const r = schema.safeParse(body(req) ?? {});
    if (!r.success) {
      const i = r.error.issues[0]!;
      throw new BankError("invalid_request", `${i.path.join(".") || "body"}: ${i.message}`, 422);
    }
    return r.data;
  };
  const amount = z.bigint().refine((v) => v > 0n, "must be positive");
  const RefundIn = z.object({
    refund_id: z.string().min(1).max(40),
    auth_ref: z.string().min(1).max(20),
    amount,
    speed: z.enum(["normal", "instant"]).default("normal"),
    scenario: z.string().max(64).nullable().optional(),
  });
  const DisputeIn = z.object({
    auth_ref: z.string().min(1).max(20),
    amount: amount.nullable().optional(),
    reason: z.enum(["fraudulent", "product_not_received", "duplicate", "credit_not_processed", "general"]).default("general"),
    scenario: z.enum(["win", "lose"]).nullable().optional(),
  });
  const EvidenceIn = z.object({ documents: z.bigint().refine((v) => v >= 0n && v <= 50n) });
  const PayoutIn = z.object({
    payout_id: z.string().min(1).max(40),
    amount,
    mode: z.enum(["IMPS", "NEFT", "RTGS", "UPI"]),
    destination: z.string().min(1).max(64),
    livemode: z.boolean(),
    scenario: z.string().max(64).nullable().optional(),
  });
  const plain = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), k.endsWith("At") ? apiTime(v as string) : v]),
    );

  app.post("/v1/refunds", auth, async (req, res) => {
    const b = parse(RefundIn, req);
    const r = await withOps((o) =>
      o.refund({ refundId: b.refund_id, authRef: b.auth_ref, amount: b.amount, speed: b.speed, scenario: b.scenario ?? null }),
    );
    send(res, 202, plain(r));
  });
  app.get("/v1/refunds/:ref", auth, async (req, res) => send(res, 200, plain(await withOps((o) => o.getRefund(String(req.params.ref))))));

  app.post("/v1/disputes", auth, async (req, res) => {
    const b = parse(DisputeIn, req);
    const d = await withOps((o) =>
      o.openDispute({ authRef: b.auth_ref, amount: b.amount ?? null, reason: b.reason, scenario: b.scenario ?? null }),
    );
    send(res, 201, plain(d));
  });
  app.get("/v1/disputes/:ref", auth, async (req, res) => send(res, 200, plain(await withOps((o) => o.getDispute(String(req.params.ref))))));
  app.post("/v1/disputes/:ref/evidence", auth, async (req, res) => {
    const b = parse(EvidenceIn, req);
    send(res, 200, plain(await withOps((o) => o.submitEvidence(String(req.params.ref), Number(b.documents)))));
  });
  app.post("/v1/disputes/:ref/accept", auth, async (req, res) =>
    send(res, 200, plain(await withOps((o) => o.acceptDispute(String(req.params.ref))))),
  );

  app.post("/v1/payouts", auth, async (req, res) => {
    const b = parse(PayoutIn, req);
    const p = await withOps((o) =>
      o.payout({
        payoutId: b.payout_id,
        amount: b.amount,
        mode: b.mode,
        destination: b.destination,
        livemode: b.livemode,
        scenario: b.scenario ?? null,
      }),
    );
    send(res, 202, plain(p));
  });
  app.get("/v1/payouts/:ref", auth, async (req, res) => send(res, 200, plain(await withOps((o) => o.getPayout(String(req.params.ref))))));

  app.get("/v1/fx/:base/:quote", auth, (req, res) => {
    const date =
      typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : new Date().toISOString().slice(0, 10);
    if (req.params.base !== "USD" || req.params.quote !== "INR") throw new BankError("unsupported_pair", "only USD/INR is quoted", 404);
    send(res, 200, { base: "USD", quote: "INR", rate: simulatedUsdInr(date), as_of: `${date}T00:00:00+00:00`, source: "junction-fx-sim" });
  });

  // FastAPI defaults for unknown routes / methods.
  const known = [/^\/healthz$/, /^\/v1\/authorizations$/, /^\/v1\/authorizations\/[^/]+$/, /^\/v1\/authorizations\/[^/]+\/(capture|void)$/];
  app.use((req, res) => {
    const exists = known.some((r) => r.test(req.path));
    send(res, exists ? 405 : 404, { detail: exists ? "Method Not Allowed" : "Not Found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BankError) {
      send(res, err.status, { error: { code: err.code, message: err.message } });
    } else if (err instanceof ValidationFailure) {
      send(res, 422, { detail: err.detail });
    } else {
      send(res, 500, { detail: "Internal Server Error" });
    }
  });
  return app;
}
