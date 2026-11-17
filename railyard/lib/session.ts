/** Railyard data access layer (server-only). The staff session token lives in an httpOnly, SameSite=Strict cookie. */
import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { ApiError, apiClient, CSRF_COOKIE } from "@mintrail/web/server";

export const SESSION_COOKIE = "mr_rys_session";
export const API_URL = process.env.MINTRAIL_UI_API_URL ?? "http://localhost:8000";

export interface Me {
  staff: { id: string; email: string; full_name: string; role: string };
  permissions: string[];
}

export async function api() {
  const c = await cookies();
  return apiClient({ baseUrl: API_URL, token: c.get(SESSION_COOKIE)?.value, userAgent: "mintrail-railyard/1.0" });
}

export const me = cache(async (): Promise<Me> => {
  try {
    return await (await api()).get<Me>("/internal/v1/auth/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect("/login?err=Your+session+has+ended.+Please+sign+in+again.");
    throw e;
  }
});

export const can = async (p: string): Promise<boolean> => (await me()).permissions.includes(p);

export async function csrfToken(): Promise<string> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? "";
}

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
