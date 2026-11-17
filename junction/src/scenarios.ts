/**
 * How Junction decides what happens to an authorization (same rules as M1):
 * 1. ``MintRail-Test-Scenario`` forwarded by Platform (test mode only);
 * 2. magic test instruments (``failure@mintrail``, card ``4000…0002`` …);
 * 3. otherwise a seeded draw — ``PyRandom(`${seed}:${paymentId}`)``.
 */
import { pyRepr } from "@mintrail/shared";

import { PyRandom, round2 } from "./pyrandom.js";

export const DECLINE_REASONS: Record<string, string> = {
  insufficient_funds: "Insufficient funds in the customer's account",
  card_declined: "The issuing bank declined the card",
  do_not_honor: "The issuer returned 'do not honour'",
  expired_card: "The card has expired",
  incorrect_cvv: "The CVV was incorrect",
  upi_collect_declined: "The customer declined the UPI collect request",
  upi_collect_expired: "The customer did not approve the UPI collect request in time",
  upi_invalid_vpa: "The VPA does not exist",
  bank_unavailable: "The customer's bank is unavailable",
  netbanking_cancelled: "The customer cancelled on the bank's page",
  risk_declined_by_issuer: "The issuer declined the payment on risk grounds",
};

export const SCENARIOS = [
  "success",
  "decline:<code>",
  "timeout",
  "delayed:<seconds>",
  "duplicate_callbacks",
  "out_of_order",
  "flaky",
  "late_success",
] as const;

export const MAGIC_VPAS: Record<string, string> = {
  "success@mintrail": "success",
  "failure@mintrail": "decline:upi_collect_declined",
  "expired@mintrail": "decline:upi_collect_expired",
  "timeout@mintrail": "timeout",
};
export const MAGIC_CARDS: Record<string, string> = {
  "411111:1111": "success",
  "400000:0002": "decline:card_declined",
  "400000:9995": "decline:insufficient_funds",
  "400000:0069": "decline:expired_card",
  "400000:0127": "decline:incorrect_cvv",
};
export const MAGIC_BANKS: Record<string, string> = { MRTEST: "success", MRFAIL: "decline:netbanking_cancelled" };

const SUCCESS_RATE: Record<string, number> = { upi: 0.93, card: 0.89, netbanking: 0.86 };
const DECLINE_MIX: Record<string, [string, number][]> = {
  card: [
    ["insufficient_funds", 0.35],
    ["card_declined", 0.25],
    ["do_not_honor", 0.2],
    ["incorrect_cvv", 0.1],
    ["expired_card", 0.1],
  ],
  upi: [
    ["upi_collect_expired", 0.4],
    ["upi_collect_declined", 0.3],
    ["insufficient_funds", 0.2],
    ["bank_unavailable", 0.1],
  ],
  netbanking: [
    ["netbanking_cancelled", 0.5],
    ["bank_unavailable", 0.3],
    ["insufficient_funds", 0.2],
  ],
};
const LATENCY_S: Record<string, [number, number]> = { upi: [2, 20], card: [0.5, 3], netbanking: [5, 40] };
export const LATE_SUCCESS_LATENCY_S = 1200;

export class UnknownScenarioError extends Error {}

export interface Plan {
  final: "authorized" | "declined" | "none";
  decline_code: string | null;
  latency_s: number;
  pending_first: boolean;
  out_of_order: boolean;
  duplicates: number;
  unavailable_attempts: number;
  source: string;
}

export const plan = (final: Plan["final"], extra: Partial<Plan> = {}): Plan => ({
  final,
  decline_code: null,
  latency_s: 0,
  pending_first: false,
  out_of_order: false,
  duplicates: 0,
  unavailable_attempts: 0,
  source: "seeded",
  ...extra,
});

/** Stored plans come back from jsonb with bigint integers; coerce. */
export function planFromDict(d: Record<string, unknown>): Plan {
  return {
    final: d.final as Plan["final"],
    decline_code: (d.decline_code as string | null) ?? null,
    latency_s: Number(d.latency_s ?? 0),
    pending_first: Boolean(d.pending_first),
    out_of_order: Boolean(d.out_of_order),
    duplicates: Number(d.duplicates ?? 0),
    unavailable_attempts: Number(d.unavailable_attempts ?? 0),
    source: String(d.source ?? "seeded"),
  };
}

const PY_FLOAT = /^\s*[+-]?(?:(?:\d(?:_?\d)*)?\.?(?:\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|inf|infinity|nan)\s*$/i;

/** Python ``float(text)`` (raises on anything Python rejects). */
function pyFloat(text: string): number {
  if (!PY_FLOAT.test(text) || !/\d|inf|nan/i.test(text)) throw new UnknownScenarioError("delayed:<seconds> needs a number");
  const t = text.trim().replaceAll("_", "").toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(t)) return Number.NaN;
  return Number(t);
}

export function planForScenario(scenario: string, method: string): Plan {
  const upi = method === "upi";
  const idx = scenario.indexOf(":");
  const name = idx < 0 ? scenario : scenario.slice(0, idx);
  const arg = idx < 0 ? "" : scenario.slice(idx + 1);
  switch (name) {
    case "success":
      return plan("authorized", { pending_first: upi, source: "scenario" });
    case "decline":
      if (!(arg in DECLINE_REASONS)) throw new UnknownScenarioError(`unknown decline code ${pyRepr(arg)}`);
      return plan("declined", { decline_code: arg, pending_first: upi, source: "scenario" });
    case "timeout":
      return plan("none", { pending_first: upi, source: "scenario" });
    case "delayed": {
      const seconds = pyFloat(arg);
      if (!(seconds >= 0 && seconds <= 3600)) throw new UnknownScenarioError("delay must be within 0..3600 seconds");
      return plan("authorized", { latency_s: seconds, pending_first: upi, source: "scenario" });
    }
    case "duplicate_callbacks":
      return plan("authorized", { duplicates: 2, source: "scenario" });
    case "out_of_order":
      return plan("authorized", { pending_first: true, out_of_order: true, source: "scenario" });
    case "flaky":
      return plan("authorized", { unavailable_attempts: 1, source: "scenario" });
    case "late_success":
      return plan("authorized", { latency_s: LATE_SUCCESS_LATENCY_S, source: "scenario" });
  }
  throw new UnknownScenarioError(`unknown scenario ${pyRepr(scenario)}; expected one of (${SCENARIOS.map(pyRepr).join(", ")})`);
}

export function magicScenario(instrument: string): string | null {
  const idx = instrument.indexOf(":");
  const kind = idx < 0 ? instrument : instrument.slice(0, idx);
  const value = idx < 0 ? "" : instrument.slice(idx + 1);
  if (kind === "upi") return MAGIC_VPAS[value.toLowerCase()] ?? null;
  if (kind === "card") return MAGIC_CARDS[value] ?? null;
  if (kind === "netbanking") return MAGIC_BANKS[value] ?? null;
  return null;
}

export function seededPlan(seed: number, paymentId: string, method: string): Plan {
  const rng = new PyRandom(`${seed}:${paymentId}`);
  const [low, high] = LATENCY_S[method] ?? [1, 5];
  const latency = round2(rng.uniform(low, high));
  const duplicates = rng.random() < 0.02 ? 1 : 0;
  const upi = method === "upi";
  const outOfOrder = upi && rng.random() < 0.01;
  if (rng.random() < (SUCCESS_RATE[method] ?? 0.9)) {
    return plan("authorized", { latency_s: latency, pending_first: upi, out_of_order: outOfOrder, duplicates });
  }
  const mix = DECLINE_MIX[method] ?? [["card_declined", 1]];
  const code = rng.choice(
    mix.map(([c]) => c),
    mix.map(([, w]) => w),
  );
  return plan("declined", { decline_code: code, latency_s: latency, pending_first: upi, out_of_order: outOfOrder, duplicates });
}

export function choosePlan(args: {
  seed: number;
  paymentId: string;
  method: string;
  instrument: string;
  scenario: string | null;
  livemode: boolean;
}): Plan {
  if (args.scenario && !args.livemode) return planForScenario(args.scenario, args.method);
  if (!args.livemode) {
    const magic = magicScenario(args.instrument);
    if (magic !== null) return { ...planForScenario(magic, args.method), source: "magic_instrument" };
  }
  return seededPlan(args.seed, args.paymentId, args.method);
}
