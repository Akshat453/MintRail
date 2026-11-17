/** Ported from conductor/tests/test_engine_integration.py. */
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { ConflictError, InvalidRequestError, Money, NotFoundError } from "@mintrail/shared";

import { type RiskInput, RiskEngine, reasons, type VelocityCounter } from "../src/engine.js";
import { openDb, truncateAll } from "../../tests/support/db.js";

let conn: ReturnType<typeof openDb>;
beforeAll(() => {
  conn = openDb();
});
afterAll(() => conn.close());
beforeEach(() => truncateAll(conn.db));

class FakeVelocity implements VelocityCounter {
  calls: Date[] = [];
  constructor(
    private attempts = 0,
    private failures = 0,
  ) {}
  async attemptsSince(_fp: string, since: Date): Promise<number> {
    this.calls.push(since);
    return this.attempts;
  }
  async failuresSince(): Promise<number> {
    return this.failures;
  }
}

const input = (extra: Partial<RiskInput> = {}): RiskInput => ({
  stationId: "mer_x",
  livemode: false,
  amount: Money.of(10_000n, "INR"),
  method: "upi",
  instrumentFingerprint: "fp",
  vpa: "asha@okaxis",
  ...extra,
});

test("allow", async () => {
  expect(await new RiskEngine(conn.db, new FakeVelocity()).evaluate(input())).toEqual({ decision: "allow", score: 0, hits: [] });
});

test("review and block precedence", async () => {
  const engine = new RiskEngine(conn.db, new FakeVelocity(4));
  expect((await engine.evaluate(input())).decision).toBe("review");
  await engine.addToBlocklist("vpa", "asha@okaxis", { reason: "mule", staffId: "stf_x" });
  const a = await engine.evaluate(input());
  expect(a.decision).toBe("block");
  expect(a.score).toBe(100);
  expect(new Set(reasons(a).map((r) => r.rule))).toEqual(new Set(["blocked_vpa", "instrument_velocity"]));
});

test("no fingerprint skips velocity", async () => {
  const v = new FakeVelocity(100);
  expect((await new RiskEngine(conn.db, v).evaluate(input({ instrumentFingerprint: null }))).decision).toBe("allow");
  expect(v.calls).toEqual([]);
});

test("blocklist lifecycle", async () => {
  const engine = new RiskEngine(conn.db, new FakeVelocity());
  const e = await engine.addToBlocklist("card_bin", " 411111 ", { reason: "BIN attack", staffId: "stf_x" });
  expect(e.id.startsWith("blk_")).toBe(true);
  expect(e.value).toBe("411111");
  await expect(engine.addToBlocklist("card_bin", "411111", { reason: "dup", staffId: "stf_x" })).rejects.toThrow(ConflictError);
  await engine.removeFromBlocklist(e.id);
  expect(await engine.listBlocklist()).toEqual([]);
  expect(await engine.listBlocklist(false)).toHaveLength(1);
  expect((await engine.removeFromBlocklist(e.id)).active).toBe(false); // idempotent
  await engine.addToBlocklist("card_bin", "411111", { reason: "again", staffId: "stf_x" });
  await expect(engine.removeFromBlocklist("blk_missing")).rejects.toThrow(NotFoundError);
});

test.each([
  ["card_bin", "41a111"],
  ["vpa", "x"],
] as const)("blocklist validation %s %s", async (kind, value) => {
  await expect(new RiskEngine(conn.db, new FakeVelocity()).addToBlocklist(kind, value, { reason: "r", staffId: "s" })).rejects.toThrow(
    InvalidRequestError,
  );
});
