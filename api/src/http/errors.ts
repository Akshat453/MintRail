/** Central error handler: every failure becomes ``{"error": {"code": "MR_…", …}}``. */
import type { NextFunction, Request, Response } from "express";

import { ErrorCode, log, MintRailError, RateLimitedError } from "@mintrail/shared";

import { sendError } from "./respond.js";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof MintRailError) {
    if (err.httpStatus >= 500) log.error({ code: err.code, err }, "server error");
    sendError(res, err.httpStatus, err.code, err.message, {
      param: err.param,
      details: err.details,
      headers: err instanceof RateLimitedError ? { "Retry-After": String(err.retryAfterS) } : undefined,
    });
    return;
  }
  const e = err as { type?: string; status?: number; name?: string; code?: string; field?: string };
  if (e?.name === "MulterError") {
    const tooLarge = e.code === "LIMIT_FILE_SIZE" || e.code === "LIMIT_FIELD_VALUE";
    sendError(
      res,
      tooLarge ? 413 : 422,
      tooLarge ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.INVALID_REQUEST,
      `upload rejected: ${e.code?.toLowerCase().replaceAll("_", " ")}`,
      {
        param: e.field ?? null,
      },
    );
    return;
  }
  if (e?.type === "entity.too.large") {
    sendError(res, 413, ErrorCode.INVALID_REQUEST, "request body too large");
    return;
  }
  log.error({ err, path: req.path }, "unhandled exception");
  sendError(res, 500, ErrorCode.INTERNAL_ERROR, "an internal error occurred");
}
