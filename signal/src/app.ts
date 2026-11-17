/**
 * Signal's own HTTP surface (port 8200): health and an internal operations API
 * for other MintRail services (bearer ``MINTRAIL_SIGNAL_API_KEY``). Merchants
 * manage endpoints through Platform (/v1/webhook_endpoints), which shares the
 * Signal library; this service owns delivery.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";

import { constantTimeEqual, type Db, MintRailError, type Settings, stringifyJson } from "@mintrail/shared";

import { EndpointService } from "./endpoints.js";
import { deliveryOut } from "./out.js";
import { signalOptions } from "./options.js";

const send = (res: Response, status: number, body: unknown): void => {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(stringifyJson(body));
};

export function createSignalApp(settings: Settings, db: Db): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const opts = signalOptions(settings);

  const auth = (req: Request, _res: Response, next: NextFunction): void => {
    const got = req.get("authorization") ?? "";
    next(
      constantTimeEqual(got, `Bearer ${settings.signal_api_key}`)
        ? undefined
        : new MintRailError("invalid service token", { code: "MR_AUTHENTICATION_REQUIRED" }),
    );
  };

  app.get("/healthz", async (_req, res) => {
    await db.execute(sql`SELECT 1`);
    send(res, 200, { status: "ok", service: "signal" });
  });

  app.get("/internal/signal/v1/stats", auth, async (_req, res) => {
    const r = await db.execute<{ status: string; n: string }>(
      sql`SELECT status, count(*)::text AS n FROM webhook_deliveries GROUP BY status`,
    );
    const backlog = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM outbox_events WHERE dispatched_at IS NULL`);
    send(res, 200, {
      object: "signal_stats",
      undispatched_events: BigInt(backlog.rows[0]?.n ?? "0"),
      deliveries: Object.fromEntries(r.rows.map((x) => [x.status, BigInt(x.n)])),
    });
  });

  app.post("/internal/signal/v1/deliveries/:id/replay", auth, async (req, res) => {
    const d = await db.transaction((tx) =>
      new EndpointService(tx, { secretBox: opts.secretBox, allowLocal: true, graceS: opts.graceS, maxAttempts: opts.maxAttempts }).replay(
        null,
        String(req.params.id),
      ),
    );
    send(res, 201, deliveryOut(d));
  });

  app.use((_req, res) => send(res, 404, { error: { code: "MR_RESOURCE_NOT_FOUND", message: "no such route" } }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MintRailError) send(res, err.httpStatus, { error: err.toDict() });
    else send(res, 500, { error: { code: "MR_INTERNAL_ERROR", message: "internal error" } });
  });
  return app;
}
