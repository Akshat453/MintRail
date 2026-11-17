/**
 * Parity harness. Record goldens against the reference implementation:
 *   PARITY_RECORD=1 pnpm parity
 * Compare any implementation against them:
 *   pnpm parity
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, expect, test } from "vitest";

import { cfg } from "../src/config.js";
import { closePool, Ctx } from "../src/ctx.js";
import { reset } from "../src/db.js";
import { SCENARIOS } from "../src/registry.js";

const selected = SCENARIOS.filter((s) => !cfg.only || cfg.only.test(s.id));

const write = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

test("scenario count", () => {
  expect(SCENARIOS.length).toBeGreaterThanOrEqual(150);
});

for (const s of selected) {
  test(s.id, async () => {
    await reset();
    const ctx = new Ctx();
    await s.run(ctx);
    const actual = JSON.parse(JSON.stringify(await ctx.finish(s.m2))) as unknown;
    const golden = `${cfg.goldenDir}/${s.id}.json`;
    if (cfg.record) {
      write(golden, actual);
      return;
    }
    write(`${cfg.actualDir}/${s.id}.json`, actual);
    const expected = JSON.parse(readFileSync(golden, "utf8")) as unknown;
    expect(actual).toEqual(expected);
  });
}

afterAll(async () => {
  await closePool();
});
