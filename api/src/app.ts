/** Platform API app factory. */
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import { type Clock, type Db, ErrorCode, SecretBox, type Settings, systemClock } from "@mintrail/shared";

import type { AppDeps } from "./deps.js";
import { errorHandler } from "./http/errors.js";
import { requestContext } from "./http/middleware.js";
import { sendError, sendJson } from "./http/respond.js";
import { makeRoute, type Routes } from "./http/route.js";
import { JunctionClient } from "./junction-client.js";
import { openApiDocument } from "./openapi.js";
import { RateLimiter } from "./ratelimit.js";
import { healthRoutes } from "./routes/health.js";
import { junctionCallbackRoutes } from "./routes/junction-callbacks.js";
import { railyardRoutes } from "./routes/railyard.js";
import { v1Routes } from "./routes/v1.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { merchantM2Routes } from "./routes/merchant-m2.js";
import { railyardM2Routes } from "./routes/railyard-m2.js";

export interface CreateAppOptions {
  settings: Settings;
  db: Db;
  junction?: JunctionClient;
  clock?: Clock;
}

export function createApp(opts: CreateAppOptions): express.Express {
  const { settings, db } = opts;
  const deps: AppDeps = {
    settings,
    db,
    secretBox: new SecretBox(settings.secrets_key),
    rateLimiter: new RateLimiter(db),
    junction: opts.junction ?? new JunctionClient(settings.junction_url, settings.junction_api_key, settings.junction_timeout_s * 1000),
    clock: opts.clock ?? systemClock,
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(requestContext);
  app.use(helmet({ contentSecurityPolicy: false }));
  const origins = settings.cors_allowed_origins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  // Everything is read raw (signatures and idempotency digests cover exact bytes) — except
  // multipart uploads, which multer streams on the routes that accept them.
  app.use(
    express.raw({ type: (req) => !(req.headers["content-type"] ?? "").startsWith("multipart/form-data"), limit: settings.max_body_bytes }),
  );
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.mr.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  });

  const routes: Routes = { router: express.Router({ strict: true }), patterns: [] };
  const route = makeRoute(routes, deps);
  healthRoutes(route, deps);
  v1Routes(route, deps);
  merchantM2Routes(route, deps, "v1");
  railyardRoutes(route, deps);
  railyardM2Routes(route, deps);
  dashboardRoutes(route, deps);
  junctionCallbackRoutes(route, deps);
  routes.router.get("/openapi.json", (_req, res) => sendJson(res, 200, openApiDocument(settings.public_base_url)));
  app.use(routes.router);

  // FastAPI-compatible fallbacks: trailing-slash redirect, 405, 404.
  app.use((req: Request, res: Response) => {
    const matches = (path: string) => routes.patterns.filter((p) => p.re.test(path));
    if (req.path.length > 1 && req.path.endsWith("/") && matches(req.path.slice(0, -1)).length > 0) {
      const q = req.originalUrl.indexOf("?");
      res.redirect(307, req.path.slice(0, -1) + (q < 0 ? "" : req.originalUrl.slice(q)));
      return;
    }
    if (matches(req.path).length > 0) {
      sendError(res, 405, ErrorCode.METHOD_NOT_ALLOWED, "method not allowed");
      return;
    }
    sendError(res, 404, ErrorCode.RESOURCE_NOT_FOUND, "no such route");
  });
  app.use(errorHandler);
  return app;
}
