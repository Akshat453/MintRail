/** OpenAPI document generated from the Zod request schemas (served at /openapi.json). */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import type { z } from "zod";

import * as S from "./routes/schemas.js";
import { API_VERSION } from "./version.js";

type Op = [method: "get" | "post" | "patch", path: string, summary: string, body?: z.ZodType, query?: z.ZodType];

const OPERATIONS: Op[] = [
  ["get", "/healthz", "Liveness"],
  ["get", "/readyz", "Readiness (database)"],
  ["get", "/v1/station", "Retrieve the calling Station"],
  ["patch", "/v1/station/settings", "Update merchant-editable settings", S.MerchantSettingsIn],
  ["get", "/v1/balance", "Merchant balance per currency", undefined, S.BalanceQuery],
  ["post", "/v1/orders", "Create an order", S.OrderCreateIn],
  ["get", "/v1/orders", "List orders", undefined, S.ListQuery],
  ["get", "/v1/orders/{order_id}", "Retrieve an order"],
  ["get", "/v1/orders/{order_id}/payments", "List an order's payments"],
  ["post", "/v1/payments", "Create a payment", S.PaymentCreateIn],
  ["get", "/v1/payments", "List payments", undefined, S.PaymentListQuery],
  ["get", "/v1/payments/{payment_id}", "Retrieve a payment"],
  ["post", "/v1/payments/{payment_id}/capture", "Capture an authorized payment", S.CaptureIn],
  ["post", "/internal/v1/auth/login", "Railyard staff login", S.LoginIn],
  ["post", "/internal/v1/auth/logout", "Railyard logout"],
  ["get", "/internal/v1/auth/me", "Current staff user"],
  ["get", "/internal/v1/staff", "List staff"],
  ["post", "/internal/v1/staff", "Create staff", S.StaffCreateIn],
  ["post", "/internal/v1/staff/{staff_id}/disable", "Disable staff"],
  ["get", "/internal/v1/audit_log", "Staff audit log", undefined, S.AuditQuery],
  ["post", "/internal/v1/stations", "Onboard a Station", S.StationCreateIn],
  ["get", "/internal/v1/stations", "List Stations", undefined, S.StationListQuery],
  ["get", "/internal/v1/stations/{station_id}", "Retrieve a Station"],
  ["patch", "/internal/v1/stations/{station_id}/settings", "Update Station settings", S.StaffSettingsIn],
  ["post", "/internal/v1/stations/{station_id}/kyc/verify", "Verify KYC"],
  ["post", "/internal/v1/stations/{station_id}/kyc/reject", "Reject KYC", S.ReasonIn],
  ["post", "/internal/v1/stations/{station_id}/kyc/reopen", "Reopen KYC"],
  ["post", "/internal/v1/stations/{station_id}/suspend", "Suspend", S.ReasonIn],
  ["post", "/internal/v1/stations/{station_id}/reactivate", "Reactivate"],
  ["get", "/internal/v1/stations/{station_id}/api_keys", "List API keys"],
  ["post", "/internal/v1/stations/{station_id}/api_keys", "Issue an API key", S.ApiKeyCreateIn],
  ["post", "/internal/v1/api_keys/{key_id}/revoke", "Revoke an API key"],
  ["get", "/internal/v1/payments/review_queue", "Risk review queue", undefined, S.ReviewQueueQuery],
  ["get", "/internal/v1/payments/{payment_id}", "Payment with event log"],
  ["post", "/internal/v1/payments/{payment_id}/risk_review", "Approve / reject a held payment", S.RiskReviewIn],
  ["get", "/internal/v1/risk/blocklist", "List blocklist"],
  ["post", "/internal/v1/risk/blocklist", "Add to blocklist", S.BlocklistIn],
  ["post", "/internal/v1/risk/blocklist/{entry_id}/deactivate", "Remove from blocklist"],
  ["get", "/internal/v1/ledger/trial_balance", "Trial balance", undefined, S.TrialBalanceQuery],
  ["get", "/internal/v1/ledger/reconcile", "Ledger reconciliation"],
  ["post", "/internal/junction/v1/callbacks", "Junction callback (signed)"],
];

let cached: unknown;

export function openApiDocument(baseUrl: string): unknown {
  if (cached) return cached;
  const registry = new OpenAPIRegistry();
  for (const [method, path, summary, body, query] of OPERATIONS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    registry.registerPath({
      method,
      path,
      summary,
      request: {
        ...(body ? { body: { content: { "application/json": { schema: body } } } } : {}),
        ...(query ? { query: query as z.ZodObject } : {}),
        ...(params.length ? { params: undefined } : {}),
      },
      responses: { 200: { description: "OK" }, default: { description: 'Error envelope: {"error": {"code": "MR_…"}}' } },
    });
  }
  cached = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "MintRail Platform API", version: API_VERSION, description: `Public API for MintRail Stations. Base URL: ${baseUrl}` },
  });
  return cached;
}
