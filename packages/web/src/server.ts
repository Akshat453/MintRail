/**
 * Server-only helpers for the Next.js apps: the API client (session token from an
 * httpOnly cookie, never exposed to the browser) and CSRF double-submit tokens.
 *
 * CSRF: every form carries a hidden ``csrf`` field equal to the ``mr_csrf`` cookie
 * (set by proxy.ts, SameSite=Strict). Server actions reject a mismatch. This is in
 * addition to Next's own Origin/Host check on Server Actions.
 */
import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

import { parseJson, stringifyJson } from "@mintrail/node";

export const CSRF_COOKIE = "mr_csrf";
export const CSRF_FIELD = "csrf";

export const newCsrfToken = (): string => randomBytes(24).toString("base64url");

export function csrfOk(form: FormData, cookieValue: string | undefined): boolean {
  const sent = form.get(CSRF_FIELD);
  if (typeof sent !== "string" || !cookieValue || sent.length !== cookieValue.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(cookieValue));
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null,
  ) {
    super(message);
  }
}

export interface ApiClient {
  /** ``revalidate``: serve from Next's data cache for that many seconds (slow, rarely-changing lists). */
  get<T = any>(path: string, query?: Record<string, string | undefined | null>, opts?: { revalidate?: number }): Promise<T>;
  post<T = any>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T>;
  patch<T = any>(path: string, body: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
  upload<T = any>(path: string, form: FormData): Promise<T>;
  raw(path: string, query?: Record<string, string | undefined | null>): Promise<Response>;
}

export function apiClient(opts: { baseUrl: string; token?: string | null; mode?: string | null; userAgent: string }): ApiClient {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "User-Agent": opts.userAgent,
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.mode ? { "MintRail-Mode": opts.mode } : {}),
    ...extra,
  });
  const url = (path: string, query?: Record<string, string | undefined | null>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    const q = qs.toString();
    return `${opts.baseUrl}${path}${q ? `?${q}` : ""}`;
  };
  const call = async <T>(
    method: string,
    path: string,
    init: {
      body?: string | FormData;
      query?: Record<string, string | undefined | null>;
      headers?: Record<string, string>;
      revalidate?: number;
    } = {},
  ): Promise<T> => {
    const caching: RequestInit & { next?: { revalidate: number } } = init.revalidate
      ? { next: { revalidate: init.revalidate } }
      : { cache: "no-store" };
    const res = await fetch(url(path, init.query), { method, headers: headers(init.headers), body: init.body, ...caching });
    const text = await res.text();
    if (res.status >= 400) {
      let err: { code?: string; message?: string; param?: string | null } = {};
      try {
        err = (parseJson<{ error?: typeof err }>(text).error ?? {}) as typeof err;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? res.statusText, err.param ?? null);
    }
    return (text ? parseJson<T>(text) : undefined) as T;
  };
  return {
    get: (path, query, opts) => call("GET", path, { query, revalidate: opts?.revalidate }),
    post: (path, body, o) =>
      call("POST", path, {
        body: body === undefined ? undefined : stringifyJson(body),
        headers: { "Content-Type": "application/json", "Idempotency-Key": o?.idempotencyKey ?? `ui_${randomBytes(12).toString("hex")}` },
      }),
    patch: (path, body) => call("PATCH", path, { body: stringifyJson(body), headers: { "Content-Type": "application/json" } }),
    del: (path) => call("DELETE", path),
    upload: (path, form) => call("POST", path, { body: form }),
    raw: (path, query) => fetch(url(path, query), { headers: headers(), cache: "no-store" }),
  };
}

/** Cookie options for session cookies. ``secure`` defaults on; local http stacks set MINTRAIL_COOKIE_SECURE=false. */
export const sessionCookie = (maxAgeS: number, sameSite: "lax" | "strict") => ({
  httpOnly: true,
  secure: process.env.MINTRAIL_COOKIE_SECURE !== "false",
  sameSite,
  path: "/",
  maxAge: maxAgeS,
});
