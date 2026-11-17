/** Request id, version header, rate-limit headers and one access-log line per request. */
import type { NextFunction, Request, Response } from "express";

import { IdPrefix, log, logContext, newId } from "@mintrail/shared";

import { API_VERSION } from "../version.js";
import type { RateDecision } from "../ratelimit.js";

const INBOUND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface RequestState {
  rawBody: Buffer;
  ratelimit?: RateDecision;
}

declare global {
  // biome-ignore lint: Express augmentation point
  namespace Express {
    interface Request {
      mr: RequestState;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get("x-request-id") ?? "";
  const requestId = INBOUND_REQUEST_ID.test(inbound) ? inbound : newId(IdPrefix.REQUEST);
  const started = process.hrtime.bigint();
  req.mr = { rawBody: Buffer.alloc(0) };
  const writeHead = res.writeHead;
  res.writeHead = function patched(this: Response, ...args: Parameters<Response["writeHead"]>) {
    this.setHeader("x-request-id", requestId);
    this.setHeader("mintrail-version", API_VERSION);
    const rl = req.mr.ratelimit;
    if (rl) {
      this.setHeader("ratelimit-limit", String(rl.limit));
      this.setHeader("ratelimit-remaining", String(rl.remaining));
    }
    return writeHead.apply(this, args);
  } as Response["writeHead"];
  res.on("finish", () => {
    logContext.run({ request_id: requestId }, () =>
      log.info(
        { method: req.method, path: req.path, status: res.statusCode, duration_ms: Number(process.hrtime.bigint() - started) / 1e6 },
        "request",
      ),
    );
  });
  logContext.run({ request_id: requestId }, () => next());
}

/** Client IP as M1 recorded it (no IPv4-mapped IPv6 prefix). */
export const clientIp = (req: Request): string | null => {
  const ip = req.socket.remoteAddress ?? null;
  return ip?.startsWith("::ffff:") ? ip.slice(7) : ip;
};
