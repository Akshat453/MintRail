/** Ported from conductor/tests/test_rules.py, plus the recorded M1 vectors. */
import { describe, expect, test } from "vitest";

import { Money } from "@mintrail/shared";

import * as rules from "../src/rules.js";
import { vectors } from "../../packages/shared/test/vectors.js";

const INR = "INR";

describe("amount limits", () => {
  test("within limits", () => expect(rules.amountLimits(Money.of(50_000_00n, INR), "upi", null)).toEqual([]));
  test("UPI cap", () => {
    const [hit] = rules.amountLimits(Money.of(1_00_000_01n, INR), "upi", null);
    expect([hit!.rule, hit!.outcome]).toEqual(["amount_over_method_limit", "block"]);
  });
  test("exactly at cap is allowed", () => expect(rules.amountLimits(Money.of(1_00_000_00n, INR), "upi", null)).toEqual([]));
  test("high value review", () => {
    const [hit] = rules.amountLimits(Money.of(2_00_000_01n, INR), "card", null);
    expect([hit!.rule, hit!.outcome]).toEqual(["high_value", "review"]);
  });
  test("station limit", () =>
    expect(rules.amountLimits(Money.of(10_001n, INR), "card", 10_000n).map((h) => h.rule)).toEqual(["amount_over_station_limit"]));
  test("block suppresses review", () =>
    expect(rules.amountLimits(Money.of(6_00_000_00n, INR), "card", null).map((h) => h.outcome)).toEqual(["block"]));
  test("unsupported method", () => expect(rules.amountLimits(Money.of(100n, "USD"), "upi", null)[0]!.rule).toBe("method_not_supported"));
  test("matches every M1 vector (rules, outcomes, detail text, weights)", () => {
    for (const v of vectors.amount_rules!) {
      const hits = rules.amountLimits(
        Money.of(BigInt(v.amount), v.currency),
        v.method,
        v.station_max === null ? null : BigInt(v.station_max),
      );
      expect(hits, JSON.stringify(v)).toEqual(v.hits);
    }
  });
});

describe("blocklist", () => {
  test("hits", () => {
    const hits = rules.blocklist({
      cardBin: "411111",
      vpa: "Mule@Ok",
      blockedBins: new Set(["411111"]),
      blockedVpas: new Set(["mule@ok"]),
    });
    expect(hits.map((h) => h.rule)).toEqual(["blocked_bin", "blocked_vpa"]);
  });
  test("misses", () =>
    expect(rules.blocklist({ cardBin: null, vpa: null, blockedBins: new Set(["1"]), blockedVpas: new Set(["x"]) })).toEqual([]));
});

describe("velocity", () => {
  test.each([
    [0, 0, []],
    [3, 0, []],
    [4, 0, [["instrument_velocity", "review"]]],
    [9, 0, [["instrument_velocity", "block"]]],
    [0, 3, [["repeated_failures", "review"]]],
    [
      9,
      5,
      [
        ["instrument_velocity", "block"],
        ["repeated_failures", "review"],
      ],
    ],
  ] as [number, number, [string, string][]][])("prior=%s failures=%s", (prior, failures, expected) => {
    expect(rules.velocity(prior, failures).map((h) => [h.rule, h.outcome])).toEqual(expected);
  });
  test("matches every M1 vector", () => {
    for (const v of vectors.velocity_rules!) expect(rules.velocity(v.prior, v.failures)).toEqual(v.hits);
  });
});
