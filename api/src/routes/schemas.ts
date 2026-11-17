/** Request schemas (Zod) — the M1 Pydantic models, constraint for constraint. */
import { z } from "zod";

import { CURRENCIES } from "@mintrail/shared";

import { PAYMENT_STATUSES, STAFF_ROLES } from "../schema/index.js";
import { emailStr, laxBool, laxInt, optional, strictInt } from "../http/validation.js";

export const Literal = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

// ---------------------------------------------------------------- stations
export const MerchantSettingsIn = z.strictObject({
  webhook_url: optional(z.string().max(500)),
  auto_capture: optional(laxBool()),
});

export const StaffSettingsIn = z.strictObject({
  webhook_url: optional(z.string().max(500)),
  auto_capture: optional(laxBool()),
  settlement_schedule: optional(Literal(["T+1", "T+2", "T+3"])),
  fee_plan: optional(Literal(["standard", "growth", "enterprise"])),
  max_payment_amount: optional(strictInt().refine((v) => v > 0n, "Input should be greater than 0")),
  rate_limit_per_sec: optional(laxInt().pipe(z.number().min(1).max(10_000))),
  rate_limit_burst: optional(laxInt().pipe(z.number().min(1).max(10_000))),
});

export const StationCreateIn = z.strictObject({
  legal_name: z.string().trim().min(2).max(200),
  display_name: z.string().trim().min(2).max(100),
  email: z.string().trim().pipe(emailStr()),
  business_category: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/),
  default_currency: Literal(CURRENCIES).default("INR"),
  settings: optional(StaffSettingsIn),
});

export const ReasonIn = z.strictObject({ reason: z.string().min(3).max(500) });

export const ApiKeyCreateIn = z.strictObject({
  mode: Literal(["test", "live"]).default("test"),
  scopes: optional(z.array(z.string())),
  label: optional(z.string().max(100)),
});

export const StationListQuery = z.object({
  limit: laxInt().pipe(z.number().min(1).max(100)).default(20),
  starting_after: optional(z.string()),
  kyc_status: optional(Literal(["pending", "verified", "rejected"])),
  q: optional(z.string().max(100)),
});

export const BalanceQuery = z.object({ currency: optional(Literal(CURRENCIES)) });

// ---------------------------------------------------------------- orders & payments
export const OrderCreateIn = z.strictObject({
  amount: strictInt(),
  currency: Literal(["INR", "USD"]).default("INR"),
  receipt: optional(z.string().max(40)),
  notes: optional(z.record(z.string(), z.unknown())),
});

export const ListQuery = z.object({
  limit: laxInt().pipe(z.number().min(1).max(100)).default(20),
  starting_after: optional(z.string()),
});

export const PaymentListQuery = ListQuery.extend({ status: optional(Literal(PAYMENT_STATUSES)) });

const CardIn = z.strictObject({
  number: z.string().min(12).max(23),
  expiry_month: laxInt(),
  expiry_year: laxInt(),
  cvv: z.string().min(3).max(4),
  name: optional(z.string().max(100)),
});

export const PaymentCreateIn = z.strictObject({
  order_id: z.string(),
  method: Literal(["card", "upi", "netbanking"]),
  card: optional(CardIn),
  upi: optional(z.strictObject({ vpa: z.string().min(3).max(320) })),
  netbanking: optional(z.strictObject({ bank_code: z.string().min(2).max(16) })),
  capture: optional(Literal(["automatic", "manual"])),
  email: optional(emailStr()),
});

export const CaptureIn = z.strictObject({ amount: optional(strictInt()) });

// ---------------------------------------------------------------- staff & ops
export const LoginIn = z.strictObject({ email: emailStr(), password: z.string().min(1).max(200) });

export const StaffCreateIn = z.strictObject({
  email: emailStr(),
  full_name: z.string().min(2).max(200),
  role: Literal(STAFF_ROLES),
  password: z.string().min(12).max(200),
});

export const AuditQuery = z.object({
  limit: laxInt().pipe(z.number().min(1).max(200)).default(50),
  starting_after: optional(laxInt().pipe(z.number().min(1))),
  target_id: optional(z.string()),
  staff_id: optional(z.string()),
});

export const ReviewQueueQuery = z.object({ limit: laxInt().pipe(z.number().min(1).max(100)).default(50) });

export const RiskReviewIn = z.strictObject({ action: Literal(["approve", "reject"]), note: z.string().max(500).default("") });

export const BlocklistIn = z.strictObject({
  kind: Literal(["card_bin", "vpa"]),
  value: z.string().min(3).max(255),
  reason: z.string().min(3).max(500),
});

export const TrialBalanceQuery = z.object({
  currency: Literal(CURRENCIES).default("INR"),
  livemode: laxBool().default(false),
});
