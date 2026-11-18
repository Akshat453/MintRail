"use server";
/**
 * Dashboard Server Actions. Every action: (1) checks the CSRF double-submit token,
 * (2) calls the Platform API with the session from the httpOnly cookie, (3) redirects
 * with a flash message. Mutations carry the form's idempotency key so a double click
 * or a retry never refunds or pays out twice. One-time secrets (API keys, webhook
 * signing secrets) are returned to the page via action state — never put in URLs.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { parseJson } from "@mintrail/node";
import { parseRupees } from "@mintrail/web";
import { ApiError, CSRF_COOKIE, csrfOk, sessionCookie } from "@mintrail/web/server";

import { api, API_URL, MODE_COOKIE, SESSION_COOKIE } from "@/lib/session";

const str = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
const back = (path: string, kind: "msg" | "err", text: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`);
const message = (e: unknown): string => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

async function guard(form: FormData, path: string): Promise<void> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) back(path, "err", "Your form expired. Reload the page and try again.");
}

// ---------------------------------------------------------------- session
export async function login(form: FormData): Promise<void> {
  await guard(form, "/login");
  let body: { token: string; expires_in: bigint; station: { live_enabled: boolean } };
  try {
    const res = await fetch(`${API_URL}/dashboard/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "mintrail-dashboard/1.0" },
      body: JSON.stringify({ email: str(form, "email"), password: String(form.get("password") ?? "") }),
      cache: "no-store",
    });
    const text = await res.text();
    const parsed = parseJson<{ error?: { message?: string } } & typeof body>(text);
    if (!res.ok) back("/login", "err", parsed?.error?.message ?? "Sign-in failed");
    body = parsed;
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back("/login", "err", "MintRail is unreachable right now. Please try again.");
  }
  const c = await cookies();
  c.set(SESSION_COOKIE, body!.token, sessionCookie(Number(body!.expires_in), "lax"));
  c.set(MODE_COOKIE, body!.station.live_enabled ? "live" : "test", { ...sessionCookie(Number(body!.expires_in), "lax"), httpOnly: false });
  redirect("/");
}

export async function logout(form: FormData): Promise<void> {
  await guard(form, "/");
  try {
    await (await api()).post("/dashboard/v1/auth/logout");
  } catch {
    /* session may already be gone */
  }
  const c = await cookies();
  c.delete(SESSION_COOKIE);
  c.delete(MODE_COOKIE);
  redirect("/login?msg=Signed+out");
}

export async function setMode(form: FormData): Promise<void> {
  await guard(form, "/");
  const mode = str(form, "mode") === "live" ? "live" : "test";
  (await cookies()).set(MODE_COOKIE, mode, { ...sessionCookie(12 * 3600, "lax"), httpOnly: false });
  redirect(str(form, "back") || "/");
}

// ---------------------------------------------------------------- refunds
export async function createRefund(form: FormData): Promise<void> {
  const id = str(form, "payment_id");
  const path = `/payments/${id}`;
  await guard(form, path);
  const raw = str(form, "amount");
  const amount = raw ? parseRupees(raw) : null;
  if (raw && amount === null) back(path, "err", "Enter the refund amount in rupees, e.g. 499 or 1,499.50");
  try {
    const r = await (
      await api()
    ).post(
      `/dashboard/v1/payments/${id}/refunds`,
      {
        ...(amount !== null ? { amount } : {}),
        reason: str(form, "reason") || "requested_by_customer",
        speed: str(form, "speed") || "normal",
      },
      { idempotencyKey: str(form, "idem") },
    );
    back(path, "msg", `Refund ${r.id} created — it will be processed by the bank shortly.`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", message(e));
  }
}

// ---------------------------------------------------------------- disputes
export async function uploadEvidence(form: FormData): Promise<void> {
  const id = str(form, "dispute_id");
  const path = `/disputes/${id}`;
  await guard(form, path);
  const out = new FormData();
  for (const f of form.getAll("files")) if (f instanceof File && f.size > 0) out.append("files", f, f.name);
  if (str(form, "text")) out.append("text", str(form, "text"));
  out.append("kind", str(form, "kind") || "other");
  try {
    await (await api()).upload(`/dashboard/v1/disputes/${id}/evidence`, out);
    back(path, "msg", "Evidence saved. Submit it when you're ready.");
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", message(e));
  }
}

export async function disputeAction(form: FormData): Promise<void> {
  const id = str(form, "dispute_id");
  const action = str(form, "action") === "accept" ? "accept" : "submit";
  const path = `/disputes/${id}`;
  await guard(form, path);
  try {
    await (await api()).post(`/dashboard/v1/disputes/${id}/${action}`, undefined, { idempotencyKey: str(form, "idem") });
    back(path, "msg", action === "submit" ? "Evidence submitted to the card network." : "Dispute accepted.");
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", message(e));
  }
}

// ---------------------------------------------------------------- webhooks
export interface SecretState {
  secret?: string;
  id?: string;
  error?: string;
  /** Extra context shown next to the one-time secret (e.g. when a rotated key stops working). */
  note?: string;
}

export async function createWebhook(_prev: SecretState, form: FormData): Promise<SecretState> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) return { error: "Your form expired. Reload the page." };
  const events = form.getAll("events").map(String).filter(Boolean);
  try {
    const ep = await (
      await api()
    ).post(
      "/dashboard/v1/webhook_endpoints",
      { url: str(form, "url"), description: str(form, "description") || null, enabled_events: events.length ? events : ["*"] },
      { idempotencyKey: str(form, "idem") },
    );
    return { secret: ep.secret, id: ep.id };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function rotateWebhookSecret(_prev: SecretState, form: FormData): Promise<SecretState> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) return { error: "Your form expired. Reload the page." };
  try {
    const ep = await (
      await api()
    ).post(`/dashboard/v1/webhook_endpoints/${str(form, "endpoint_id")}/rotate_secret`, undefined, { idempotencyKey: str(form, "idem") });
    return { secret: ep.secret, id: ep.id };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function updateWebhook(form: FormData): Promise<void> {
  const id = str(form, "endpoint_id");
  const path = `/webhooks/${id}`;
  await guard(form, path);
  try {
    const op = str(form, "op");
    if (op === "delete") {
      await (await api()).del(`/dashboard/v1/webhook_endpoints/${id}`);
      back("/webhooks", "msg", "Endpoint deleted.");
    }
    await (await api()).patch(`/dashboard/v1/webhook_endpoints/${id}`, { status: op === "disable" ? "disabled" : "enabled" });
    back(path, "msg", op === "disable" ? "Endpoint disabled." : "Endpoint enabled.");
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", message(e));
  }
}

export async function replayDelivery(form: FormData): Promise<void> {
  const path = str(form, "back") || "/webhooks";
  await guard(form, path);
  try {
    const d = await (
      await api()
    ).post(`/dashboard/v1/webhook_deliveries/${str(form, "delivery_id")}/replay`, undefined, { idempotencyKey: str(form, "idem") });
    back(path, "msg", `Replay queued as ${d.id}.`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", message(e));
  }
}

// ---------------------------------------------------------------- API keys
export async function createApiKey(_prev: SecretState, form: FormData): Promise<SecretState> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) return { error: "Your form expired. Reload the page." };
  try {
    const k = await (
      await api()
    ).post(
      "/dashboard/v1/api_keys",
      { mode: str(form, "mode") || "test", label: str(form, "label") || null },
      { idempotencyKey: str(form, "idem") },
    );
    return { secret: k.secret, id: k.id };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function rotateApiKey(_prev: SecretState, form: FormData): Promise<SecretState> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) return { error: "Your form expired. Reload the page." };
  try {
    const k = await (
      await api()
    ).post(`/dashboard/v1/api_keys/${str(form, "key_id")}/rotate`, undefined, { idempotencyKey: str(form, "idem") });
    const until = k.replaced_key_expires_at
      ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(
          new Date(k.replaced_key_expires_at),
        )
      : null;
    return {
      secret: k.secret,
      id: k.id,
      note: until
        ? `The old key ${k.replaces} keeps working until ${until} IST, then stops.`
        : `The old key ${k.replaces} stops working now.`,
    };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function revokeApiKey(form: FormData): Promise<void> {
  await guard(form, "/api-keys");
  try {
    await (await api()).post(`/dashboard/v1/api_keys/${str(form, "key_id")}/revoke`, undefined, { idempotencyKey: str(form, "idem") });
    back("/api-keys", "msg", "Key revoked. Requests using it now fail with MR_API_KEY_REVOKED.");
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back("/api-keys", "err", message(e));
  }
}

// ---------------------------------------------------------------- payouts
export async function createPayout(form: FormData): Promise<void> {
  await guard(form, "/payouts");
  const amount = parseRupees(str(form, "amount"));
  if (amount === null) back("/payouts", "err", "Enter the amount in rupees, e.g. 2500");
  const mode = str(form, "mode");
  try {
    const p = await (
      await api()
    ).post(
      "/dashboard/v1/payouts",
      {
        amount,
        mode,
        purpose: str(form, "purpose") || "vendor_bill",
        beneficiary:
          mode === "UPI"
            ? { name: str(form, "name"), vpa: str(form, "vpa") }
            : { name: str(form, "name"), account_number: str(form, "account_number"), ifsc: str(form, "ifsc").toUpperCase() },
        reference: str(form, "reference") || null,
      },
      { idempotencyKey: str(form, "idem") },
    );
    back(
      "/payouts",
      "msg",
      p.status === "pending_approval" ? `Payout ${p.id} needs MintRail approval (large amount).` : `Payout ${p.id} queued.`,
    );
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back("/payouts", "err", message(e));
  }
}

export async function bulkPayouts(form: FormData): Promise<void> {
  await guard(form, "/payouts");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) back("/payouts", "err", "Choose a CSV file.");
  const out = new FormData();
  out.append("file", file as File, (file as File).name);
  try {
    const b = await (await api()).upload("/dashboard/v1/payouts/bulk", out);
    back(
      "/payouts",
      b.rejected_count > 0n ? "err" : "msg",
      `${b.accepted_count} payouts queued, ${b.rejected_count} rows rejected${b.rejected_count > 0n ? `: ${b.errors.map((x: { row: bigint; message: string }) => `row ${x.row} — ${x.message}`).join("; ")}` : ""}.`,
    );
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back("/payouts", "err", message(e));
  }
}
