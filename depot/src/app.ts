/**
 * Depot's small internal API (port 8300, bearer ``MINTRAIL_DEPOT_API_KEY``):
 * trigger a run, run reconciliation now, fetch a settlement report CSV.
 * Merchants and Railyard read settlements through Platform.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";

import { constantTimeEqual, type Db, ErrorCode, istDate, MintRailError, type Settings, stringifyJson } from "@mintrail/shared";
import { reconciliationOut, SettlementReader, settlementOut } from "@mintrail/api";

import type { FxFeed } from "./fx.js";
import { reconcile } from "./reconcile.js";
import { runSettlements } from "./run.js";

const send = (res: Response, status: number, body: unknown): void => {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(stringifyJson(body));
};

export function createDepotApp(settings: Settings, db: Db, fx: FxFeed): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  const auth = (req: Request, _res: Response, next: NextFunction): void => {
    next(
      constantTimeEqual(req.get("authorization") ?? "", `Bearer ${settings.depot_api_key}`)
        ? undefined
        : new MintRailError("invalid service token", { code: ErrorCode.AUTHENTICATION_REQUIRED }),
    );
  };

  app.get("/healthz", async (_req, res) => {
    await db.execute(sql`SELECT 1`);
    send(res, 200, { status: "ok", service: "depot" });
  });

  app.post("/internal/depot/v1/runs", auth, async (req, res) => {
    const date = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : istDate(new Date());
    const r = await runSettlements(db, settings, fx, date);
    send(res, 201, {
      object: "settlement_run",
      date,
      created: BigInt(r.created),
      skipped: BigInt(r.skipped),
      failed: BigInt(r.failed),
      settlements: r.settlements.map(settlementOut),
    });
  });

  app.post("/internal/depot/v1/reconciliations", auth, async (_req, res) => {
    const [report, items] = await db.transaction((tx) => reconcile(tx));
    send(
      res,
      201,
      reconciliationOut(
        report,
        items.map((m, i) => ({
          id: BigInt(i),
          reportId: report.id,
          stationId: m.stationId ?? null,
          livemode: m.livemode ?? null,
          currency: m.currency ?? null,
          check: m.check,
          referenceId: m.referenceId ?? null,
          expected: m.expected ?? null,
          actual: m.actual ?? null,
          detail: m.detail ?? null,
        })),
      ),
    );
  });

  app.get("/internal/depot/v1/settlements/:id/report.csv", auth, async (req, res) => {
    const [s, csv] = await new SettlementReader(db).reportCsv(null, String(req.params.id));
    res.status(200).setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="settlement-${s.settlementDate}-${s.id}.csv"`);
    res.end(csv);
  });

  app.use((_req, res) => send(res, 404, { error: { code: ErrorCode.RESOURCE_NOT_FOUND, message: "no such route" } }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MintRailError) send(res, err.httpStatus, { error: err.toDict() });
    else send(res, 500, { error: { code: ErrorCode.INTERNAL_ERROR, message: "internal error" } });
  });
  return app;
}
