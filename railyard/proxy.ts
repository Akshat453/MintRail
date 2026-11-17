/**
 * Railyard proxy (Next.js 16's renamed middleware): sends signed-out visitors to
 * /login and makes sure every visitor has a CSRF token cookie (double-submit).
 * The cookie is also injected into this request so the first render can embed it.
 */
import { randomBytes } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

const SESSION = "mr_rys_session";
const CSRF = "mr_csrf";

export function proxy(req: NextRequest) {
  const publicPath = req.nextUrl.pathname === "/login" || req.nextUrl.pathname.startsWith("/healthz");
  if (!publicPath && !req.cookies.get(SESSION)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const existing = req.cookies.get(CSRF)?.value;
  if (existing) return NextResponse.next();
  const token = randomBytes(24).toString("base64url");
  const headers = new Headers(req.headers);
  headers.set("cookie", [req.headers.get("cookie"), `${CSRF}=${token}`].filter(Boolean).join("; "));
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(CSRF, token, { httpOnly: true, sameSite: "strict", secure: process.env.MINTRAIL_COOKIE_SECURE !== "false", path: "/" });
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
