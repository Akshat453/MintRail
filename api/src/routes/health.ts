import { sql } from "drizzle-orm";

import type { AppDeps } from "../deps.js";
import type { makeRoute } from "../http/route.js";
import { errorBody } from "../http/respond.js";
import { API_VERSION } from "../version.js";

export function healthRoutes(route: ReturnType<typeof makeRoute>, deps: AppDeps): void {
  route("get", "/healthz", {}, async () => ({ status: 200, body: { status: "ok", version: API_VERSION } }));
  route("get", "/readyz", {}, async () => {
    try {
      await deps.db.execute(sql`SELECT 1`);
    } catch {
      return { status: 503, body: errorBody("MR_SERVICE_UNAVAILABLE", "database unavailable") };
    }
    return { status: 200, body: { status: "ok", version: API_VERSION } };
  });
}
