/** JSON responses with exact money (bigint) and M1's ``application/json`` content type. */
import type { Response } from "express";

import { logContext, stringifyJson, type ErrorCode } from "@mintrail/shared";

export function sendJson(res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.status(status);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");
  if (status === 204 || body === undefined) {
    res.end();
    return;
  }
  res.end(Buffer.from(stringifyJson(body)));
}

export function errorBody(
  code: ErrorCode,
  message: string,
  param?: string | null,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { code, message };
  if (param != null) body.param = param;
  if (details && Object.keys(details).length > 0) body.details = details;
  const rid = logContext.getStore()?.request_id;
  if (rid !== undefined) body.request_id = rid;
  return { error: body };
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  opts: { param?: string | null; details?: Record<string, unknown>; headers?: Record<string, string> } = {},
): void {
  const headers = { ...(opts.headers ?? {}) };
  if (status === 401) headers["WWW-Authenticate"] = "Bearer";
  sendJson(res, status, errorBody(code, message, opts.param, opts.details), headers);
}
