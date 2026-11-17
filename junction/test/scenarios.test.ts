import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  choosePlan,
  LATE_SUCCESS_LATENCY_S,
  magicScenario,
  plan,
  planForScenario,
  planFromDict,
  seededPlan,
  UnknownScenarioError,
} from "../src/scenarios.js";

// biome-ignore lint: fixture
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../tests/parity/fixtures/python-vectors.json", import.meta.url)), "utf8"),
) as Record<string, any[]>;

describe("seeded plans (PyRandom ≡ CPython random.Random)", () => {
  test("every recorded M1 seeded plan reproduces exactly", () => {
    for (const v of vectors.seeded_plans!) {
      expect(seededPlan(v.seed, v.payment_id, v.method), `${v.seed}:${v.payment_id} ${v.method}`).toEqual(planFromDict(v.plan));
    }
  });
  test("every recorded scenario plan reproduces exactly", () => {
    for (const v of vectors.scenario_plans!) {
      expect(planForScenario(v.scenario, v.method)).toEqual(planFromDict(v.plan));
    }
  });
  test("deterministic and seed-sensitive", () => {
    const a = Array.from({ length: 200 }, (_, i) => seededPlan(1, `pay_${i}`, "card"));
    expect(Array.from({ length: 200 }, (_, i) => seededPlan(1, `pay_${i}`, "card"))).toEqual(a);
    expect(Array.from({ length: 200 }, (_, i) => seededPlan(2, `pay_${i}`, "card"))).not.toEqual(a);
  });
  test.each([
    ["upi", 0.88, 0.98],
    ["card", 0.83, 0.95],
    ["netbanking", 0.79, 0.93],
  ])("success rate realistic for %s", (method, low, high) => {
    const plans = Array.from({ length: 2000 }, (_, i) => seededPlan(20221, `pay_${i}`, method));
    const rate = plans.filter((p) => p.final === "authorized").length / plans.length;
    expect(rate).toBeGreaterThan(low);
    expect(rate).toBeLessThan(high);
    expect(plans.filter((p) => p.final === "declined").every((p) => p.decline_code)).toBe(true);
  });
});

describe("scenarios", () => {
  test.each([
    ["success", "upi", plan("authorized", { pending_first: true, source: "scenario" })],
    ["success", "card", plan("authorized", { source: "scenario" })],
    ["decline:insufficient_funds", "card", plan("declined", { decline_code: "insufficient_funds", source: "scenario" })],
    ["timeout", "card", plan("none", { source: "scenario" })],
    ["delayed:12.5", "card", plan("authorized", { latency_s: 12.5, source: "scenario" })],
    ["duplicate_callbacks", "card", plan("authorized", { duplicates: 2, source: "scenario" })],
    ["out_of_order", "card", plan("authorized", { pending_first: true, out_of_order: true, source: "scenario" })],
    ["flaky", "card", plan("authorized", { unavailable_attempts: 1, source: "scenario" })],
    ["late_success", "card", plan("authorized", { latency_s: LATE_SUCCESS_LATENCY_S, source: "scenario" })],
  ])("%s / %s", (scenario, method, expected) => {
    expect(planForScenario(scenario, method)).toEqual(expected);
  });

  test.each(["nope", "decline:made_up", "delayed:x", "delayed:99999", "delayed:", "delayed:nan"])("unknown: %s", (s) => {
    expect(() => planForScenario(s, "card")).toThrow(UnknownScenarioError);
  });

  test("error messages match M1", () => {
    expect(() => planForScenario("nope", "card")).toThrow(
      "unknown scenario 'nope'; expected one of ('success', 'decline:<code>', 'timeout', 'delayed:<seconds>', 'duplicate_callbacks', 'out_of_order', 'flaky', 'late_success')",
    );
    expect(() => planForScenario("decline:x", "card")).toThrow("unknown decline code 'x'");
    expect(() => planForScenario("delayed:x", "card")).toThrow("delayed:<seconds> needs a number");
    expect(() => planForScenario("delayed:5000", "card")).toThrow("delay must be within 0..3600 seconds");
  });

  test("magic instruments", () => {
    expect(magicScenario("upi:failure@mintrail")).toBe("decline:upi_collect_declined");
    expect(magicScenario("card:400000:9995")).toBe("decline:insufficient_funds");
    expect(magicScenario("netbanking:MRTEST")).toBe("success");
    expect(magicScenario("upi:someone@okaxis")).toBeNull();
    expect(magicScenario("wallet:x")).toBeNull();
    expect(magicScenario("nocolon")).toBeNull();
  });

  test("priority: scenario > magic > seeded; live ignores both", () => {
    const p = (scenario: string | null, livemode: boolean) =>
      choosePlan({ seed: 1, paymentId: "pay_1", method: "upi", instrument: "upi:failure@mintrail", scenario, livemode });
    expect(p("success", false).final).toBe("authorized");
    expect(p(null, false).source).toBe("magic_instrument");
    expect(p("timeout", true).source).toBe("seeded");
  });

  test("plan round trip through jsonb (bigint integers)", () => {
    const x = plan("declined", { decline_code: "card_declined", latency_s: 1.5, duplicates: 1 });
    expect(planFromDict({ ...x, duplicates: 1n, unavailable_attempts: 0n })).toEqual(x);
  });
});
