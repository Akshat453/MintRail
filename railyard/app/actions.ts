"use server";
/**
 * Railyard Server Actions: CSRF-checked, executed with the staff session from the
 * httpOnly cookie. Permission checks happen in the Platform API (and every mutation
 * is written to the staff audit log there).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { parseJson, stringifyJson } from "@mintrail/node";
import { parseRupees } from "@mintrail/web";
import { ApiError, CSRF_COOKIE, csrfOk, sessionCookie } from "@mintrail/web/server";

import { api, API_URL, SESSION_COOKIE } from "@/lib/session";

const str = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
const back = (path: string, kind: "msg" | "err", text: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`);

async function guard(form: FormData, path: string): Promise<void> {
  if (!csrfOk(form, (await cookies()).get(CSRF_COOKIE)?.value)) back(path, "err", "Your form expired. Reload the page and try again.");
}

/** Run an API mutation and redirect with its outcome. */
async function run(form: FormData, path: string, fn: (a: Awaited<ReturnType<typeof api>>) => Promise<string>): Promise<void> {
  await guard(form, path);
  let msg: string;
  try {
    msg = await fn(await api());
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back(path, "err", e.status === 403 ? `Not allowed for your role: ${e.message}` : e.message);
  }
  back(path, "msg", msg!);
}

export async function login(form: FormData): Promise<void> {
  await guard(form, "/login");
  const res = await fetch(`${API_URL}/internal/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "mintrail-railyard/1.0" },
    body: stringifyJson({ email: str(form, "email"), password: String(form.get("password") ?? "") }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) back("/login", "err", "MintRail API is unreachable.");
  const body = parseJson<{ token?: string; expires_in?: bigint; error?: { message: string } }>(await res!.text());
  if (!res!.ok || !body.token) back("/login", "err", body.error?.message ?? "Sign-in failed");
  (await cookies()).set(SESSION_COOKIE, body.token!, sessionCookie(Number(body.expires_in ?? 28_800n), "strict"));
  redirect("/");
}

export async function logout(form: FormData): Promise<void> {
  await guard(form, "/");
  await (await api()).post("/internal/v1/auth/logout").catch(() => undefined);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login?msg=Signed+out");
}

export async function kycDecision(form: FormData): Promise<void> {
  const id = str(form, "station_id");
  const decision = str(form, "decision");
  await run(form, str(form, "back") || "/kyc", async (a) => {
    if (decision === "verify") await a.post(`/internal/v1/stations/${id}/kyc/verify`);
    else await a.post(`/internal/v1/stations/${id}/kyc/reject`, { reason: str(form, "reason") || "Documents could not be verified" });
    return `KYC ${decision === "verify" ? "verified" : "rejected"} for ${id}.`;
  });
}

export async function updatePolicy(form: FormData): Promise<void> {
  const id = str(form, "station_id");
  await run(form, `/merchants/${id}`, async (a) => {
    const limit = parseRupees(str(form, "payout_daily_limit"));
    const threshold = parseRupees(str(form, "payout_approval_threshold"));
    await a.patch(`/internal/v1/stations/${id}/policy`, {
      reserve_bps: Number(str(form, "reserve_bps") || "0"),
      reserve_hold_days: Number(str(form, "reserve_hold_days") || "0"),
      ...(limit ? { payout_daily_limit: limit } : {}),
      ...(threshold ? { payout_approval_threshold: threshold } : {}),
    });
    return "Policy updated (audited).";
  });
}

export async function stationStatus(form: FormData): Promise<void> {
  const id = str(form, "station_id");
  await run(form, `/merchants/${id}`, async (a) => {
    if (str(form, "op") === "suspend")
      await a.post(`/internal/v1/stations/${id}/suspend`, { reason: str(form, "reason") || "Suspended by MintRail ops" });
    else await a.post(`/internal/v1/stations/${id}/reactivate`);
    return "Station status updated.";
  });
}

export async function disputeAction(form: FormData): Promise<void> {
  const id = str(form, "dispute_id");
  const op = str(form, "op") === "submit" ? "submit" : "accept";
  await run(form, `/disputes/${id}`, async (a) => {
    await a.post(`/internal/v1/disputes/${id}/${op}`);
    return op === "submit" ? "Evidence submitted on the merchant's behalf." : "Dispute accepted on the merchant's behalf.";
  });
}

export async function payoutDecision(form: FormData): Promise<void> {
  const id = str(form, "payout_id");
  await run(form, "/payouts", async (a) => {
    if (str(form, "decision") === "approve") {
      await a.post(`/internal/v1/payouts/${id}/approve`);
      return `Payout ${id} approved.`;
    }
    await a.post(`/internal/v1/payouts/${id}/reject`, { reason: str(form, "reason") || "Rejected by MintRail finance" });
    return `Payout ${id} rejected; funds returned to the merchant.`;
  });
}

export async function replayDelivery(form: FormData): Promise<void> {
  await run(form, str(form, "back") || "/webhooks", async (a) => {
    const d = await a.post(`/internal/v1/webhook_deliveries/${str(form, "delivery_id")}/replay`);
    return `Replay queued as ${d.id}.`;
  });
}

export async function runSettlements(form: FormData): Promise<void> {
  await run(form, "/settlements", async (a) => {
    const r = await a.post("/internal/v1/settlements/run", str(form, "date") ? { date: str(form, "date") } : {});
    return `Settlement run for ${r.date} queued.`;
  });
}

export async function runReconciliation(form: FormData): Promise<void> {
  await run(form, "/settlements", async (a) => {
    await a.post("/internal/v1/reconciliation/run", {});
    return "Reconciliation queued — refresh in a few seconds.";
  });
}

export async function openDerailment(form: FormData): Promise<void> {
  await guard(form, "/derailments");
  let id = "";
  try {
    const d = await (
      await api()
    ).post("/internal/v1/derailments", {
      title: str(form, "title"),
      severity: str(form, "severity") || "sev3",
      summary: str(form, "summary"),
      affected: str(form, "affected")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    id = d.id;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    back("/derailments", "err", e.message);
  }
  redirect(`/derailments/${id}?msg=Derailment+opened`);
}

export async function addDerailmentNote(form: FormData): Promise<void> {
  const id = str(form, "derailment_id");
  await run(form, `/derailments/${id}`, async (a) => {
    await a.post(`/internal/v1/derailments/${id}/notes`, {
      body: str(form, "body"),
      ...(str(form, "status") ? { status: str(form, "status") } : {}),
    });
    return "Note added.";
  });
}
