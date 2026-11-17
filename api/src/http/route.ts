/**
 * Route wrapper reproducing FastAPI's dependency order from M1:
 *   merchant auth (+ rate limit) → scope → staff auth → permission →
 *   Idempotency-Key validation → query validation → body validation → handler.
 * Errors are rendered by the central error handler (errors.ts).
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import multer from "multer";
import type { z } from "zod";

import { AuthenticationError, ErrorCode, parseJson, PermissionDeniedError, RateLimitedError, type Tx } from "@mintrail/shared";

import { HEADER as IDEMPOTENCY_HEADER, Idempotency, type Reply, validateKey } from "../idempotency.js";
import type { Scope } from "../scopes.js";
import { type AuthContext, type Principal, StationService } from "../services/stations.js";
import { type Permission, type StaffContext, StaffService } from "../services/staff.js";
import { DashboardAuthService, type DashboardContext, type DashboardPermission } from "../services/dashboard-auth.js";
import { KEY_ID_HEADER, SIGNATURE_HEADER } from "../signing.js";
import type { AppDeps } from "../deps.js";
import { sendJson } from "./respond.js";
import { ValidationError, validate } from "./validation.js";

export interface RouteSpec<Q extends z.ZodType | undefined, B extends z.ZodType | undefined> {
  merchant?: { scope?: Scope };
  staff?: Permission | "any";
  /** Merchant dashboard session (``Authorization: Bearer dss_…`` + ``MintRail-Mode: test|live``). */
  dashboard?: DashboardPermission | "any";
  idempotent?: boolean;
  query?: Q;
  body?: B;
  /** multipart/form-data upload: files in ``field`` (memory storage, hard limits). Other form fields land in ``c.form``. */
  upload?: { field: string; maxFiles: number; maxBytes: number };
}

export interface Call<Q, B> {
  req: Request;
  res: Response;
  deps: AppDeps;
  params: Record<string, string>;
  /** API key (``AuthContext``) or dashboard session — both are a Principal. */
  auth: AuthContext;
  principal: Principal;
  dash: DashboardContext;
  staff: StaffContext;
  files: Express.Multer.File[];
  form: Record<string, string>;
  idem: Idempotency;
  query: Q;
  body: B;
}

export type Handler<Q, B> = (c: Call<Q, B>) => Promise<Reply>;

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export const stationService = (deps: AppDeps, tx: Tx) =>
  new StationService(tx, {
    pepper: deps.settings.api_key_pepper,
    secretBox: deps.secretBox,
    clock: deps.clock,
    allowLocalWebhooks: deps.settings.environment === "dev" || deps.settings.environment === "test",
  });

function bearer(authorization: string): string {
  const idx = authorization.indexOf(" ");
  const scheme = idx < 0 ? authorization : authorization.slice(0, idx);
  const token = idx < 0 ? "" : authorization.slice(idx + 1);
  if (scheme.toLowerCase() !== "bearer" || !token.trim()) {
    throw new AuthenticationError("Authorization header must use the Bearer scheme", { code: ErrorCode.AUTHENTICATION_REQUIRED });
  }
  return token.trim();
}

async function authenticateMerchant(req: Request, deps: AppDeps): Promise<AuthContext> {
  const keyId = req.get(KEY_ID_HEADER) ?? "";
  const signature = req.get(SIGNATURE_HEADER) ?? "";
  const authorization = req.get("authorization") ?? "";
  const ctx = await deps.db.transaction(async (tx) => {
    const svc = stationService(deps, tx);
    if (keyId || signature) {
      if (!(keyId && signature)) {
        throw new AuthenticationError(`signed requests need both ${KEY_ID_HEADER} and ${SIGNATURE_HEADER}`, {
          code: ErrorCode.SIGNATURE_REQUIRED,
        });
      }
      const q = req.originalUrl.indexOf("?");
      return svc.authenticateSigned(keyId, signature, {
        method: req.method,
        path: req.path,
        query: q < 0 ? "" : req.originalUrl.slice(q + 1),
        body: req.mr.rawBody,
        now: Math.floor(Date.now() / 1000),
        toleranceS: deps.settings.request_signature_tolerance_s,
      });
    }
    if (authorization) return svc.authenticateBearer(bearer(authorization));
    throw new AuthenticationError("authenticate with 'Authorization: Bearer mr_test_…' or a signed request", {
      code: ErrorCode.AUTHENTICATION_REQUIRED,
    });
  });
  if (deps.settings.rate_limiting_enabled) {
    const decision = await deps.rateLimiter.acquire(
      `station:${ctx.station.id}:${ctx.mode}`,
      ctx.station.rateLimitPerSec,
      ctx.station.rateLimitBurst,
    );
    req.mr.ratelimit = decision;
    if (!decision.allowed) throw new RateLimitedError("too many requests; slow down", decision.retryAfterS);
  }
  return ctx;
}

export const MODE_HEADER = "MintRail-Mode";

async function authenticateDashboard(req: Request, deps: AppDeps): Promise<DashboardContext> {
  const authorization = req.get("authorization") ?? "";
  if (!authorization) throw new AuthenticationError("dashboard session token required");
  const mode = (req.get(MODE_HEADER) ?? "test").toLowerCase();
  if (mode !== "test" && mode !== "live") throw new AuthenticationError(`${MODE_HEADER} must be test or live`);
  return deps.db.transaction((tx) => new DashboardAuthService(tx, deps.settings, deps.clock).resolve(bearer(authorization), mode));
}

async function authenticateStaff(req: Request, deps: AppDeps): Promise<StaffContext> {
  const authorization = req.get("authorization") ?? "";
  if (!authorization) throw new AuthenticationError("Railyard session token required");
  const token = bearer(authorization);
  return deps.db.transaction((tx) => new StaffService(tx, deps.settings, deps.clock).resolve(token));
}

function lastValues(query: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    const value = Array.isArray(v) ? v[v.length - 1] : v;
    if (typeof value === "string") out[k] = value;
  }
  return out;
}

function parseBody(raw: Buffer): unknown {
  if (raw.length === 0) {
    throw new ValidationError("Field required", { param: null });
  }
  try {
    return parseJson(raw.toString("utf8"));
  } catch (e) {
    const pos = /position (\d+)/.exec((e as Error).message)?.[1] ?? null;
    throw new ValidationError(pos ? `${pos}: JSON decode error` : "JSON decode error", { param: pos });
  }
}

export interface Routes {
  router: Router;
  patterns: { method: string; re: RegExp }[];
}

export function makeRoute(routes: Routes, deps: AppDeps) {
  return function route<Q extends z.ZodType | undefined = undefined, B extends z.ZodType | undefined = undefined>(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    spec: RouteSpec<Q, B>,
    handler: Handler<Out<Q>, Out<B>>,
  ): void {
    routes.patterns.push({ method: method.toUpperCase(), re: new RegExp(`^${path.replace(/:[A-Za-z_]+/g, "[^/]+")}$`) });
    const middleware: RequestHandler[] = [];
    if (spec.upload) {
      const up = multer({
        storage: multer.memoryStorage(),
        limits: {
          fileSize: spec.upload.maxBytes,
          files: spec.upload.maxFiles,
          fields: 20,
          fieldSize: 64 * 1024,
          parts: spec.upload.maxFiles + 20,
        },
      }).array(spec.upload.field, spec.upload.maxFiles);
      middleware.push((req: Request, res: Response, next: NextFunction) => {
        if (!(req.get("content-type") ?? "").startsWith("multipart/form-data")) {
          next(new ValidationError("expected multipart/form-data", { param: spec.upload!.field }));
          return;
        }
        up(req, res, next);
      });
    }
    routes.router[method](path, ...middleware, async (req: Request, res: Response) => {
      const c = { req, res, deps, params: req.params as Record<string, string> } as Call<Out<Q>, Out<B>>;
      if (spec.upload) {
        c.files = (req.files as Express.Multer.File[] | undefined) ?? [];
        c.form = Object.fromEntries(
          Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? String(v.at(-1)) : String(v)]),
        );
      }
      if (spec.dashboard) {
        c.dash = await authenticateDashboard(req, deps);
        if (spec.dashboard !== "any") c.dash.require(spec.dashboard);
        c.principal = c.dash;
        c.auth = c.dash as unknown as AuthContext;
      }
      if (spec.merchant) {
        c.auth = await authenticateMerchant(req, deps);
        c.principal = c.auth;
        const scope = spec.merchant.scope;
        if (scope && !c.auth.hasScope(scope)) {
          throw new PermissionDeniedError(`this API key lacks the '${scope}' scope`, { code: ErrorCode.INSUFFICIENT_SCOPE });
        }
      }
      if (spec.staff) {
        c.staff = await authenticateStaff(req, deps);
        if (spec.staff !== "any" && !c.staff.can(spec.staff)) {
          throw new PermissionDeniedError(`role '${c.staff.role}' lacks permission '${spec.staff}'`);
        }
      }
      if (spec.idempotent) {
        const key = validateKey(req.get(IDEMPOTENCY_HEADER) ?? undefined);
        c.idem = new Idempotency(
          deps.db,
          { stationId: c.auth.station.id, livemode: c.auth.livemode },
          key,
          req.method,
          req.path,
          req.mr.rawBody,
          deps.settings.idempotency_lock_timeout_s,
        );
      }
      if (spec.query) c.query = validate(spec.query, lastValues(req.query)) as Out<Q>;
      if (spec.body) c.body = validate(spec.body, spec.upload ? c.form : parseBody(req.mr.rawBody)) as Out<B>;
      const reply = await handler(c);
      if (reply.raw) {
        res.status(reply.status);
        for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
        res.setHeader("Content-Type", reply.raw.contentType);
        res.setHeader("Cache-Control", "no-store");
        if (reply.raw.filename)
          res.setHeader("Content-Disposition", `attachment; filename="${reply.raw.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
        res.end(reply.raw.body);
        return;
      }
      sendJson(res, reply.status, reply.body, reply.headers);
    });
  };
}
