/** Dashboard data access layer (server-only): the session lives in an httpOnly cookie and never reaches the browser. */
import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { ApiError, apiClient, CSRF_COOKIE } from "@mintrail/web/server";

export const SESSION_COOKIE = "mr_dash_session";
export const MODE_COOKIE = "mr_mode";
export const API_URL = process.env.MINTRAIL_UI_API_URL ?? "http://localhost:8000";

export interface Me {
  user: { id: string; email: string; full_name: string; role: string };
  station: {
    id: string;
    display_name: string;
    legal_name: string;
    live_enabled: boolean;
    kyc_status: string;
    default_currency: string;
    settings: Record<string, unknown>;
  };
  livemode: boolean;
  permissions: string[];
}

export async function api() {
  const c = await cookies();
  return apiClient({
    baseUrl: API_URL,
    token: c.get(SESSION_COOKIE)?.value,
    mode: c.get(MODE_COOKIE)?.value ?? "test",
    userAgent: "mintrail-dashboard/1.0",
  });
}

/** The signed-in user; redirects to /login when the session is gone or expired. */
export const me = cache(async (): Promise<Me> => {
  try {
    return await (await api()).get<Me>("/dashboard/v1/me");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403))
      redirect("/login?err=Your+session+has+ended.+Please+sign+in+again.");
    throw e;
  }
});

export async function csrfToken(): Promise<string> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? "";
}

/** Run an API read; turn auth failures into a login redirect. */
export async function load<T>(fn: (a: Awaited<ReturnType<typeof api>>) => Promise<T>): Promise<T> {
  try {
    return await fn(await api());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect("/login");
    throw e;
  }
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
