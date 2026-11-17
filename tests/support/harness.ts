/** Vitest fixture: a fresh Harness per test over a truncated database. */
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { Harness } from "@mintrail/api/testing";
import { createApp as createJunctionApp, buildRegistry as junctionRegistry } from "@mintrail/junction";
import type { Db, Settings } from "@mintrail/shared";

import { openDb, testSettings, truncateAll } from "./db.js";

export function useHarness(overrides: Partial<Settings> = {}): { h: () => Harness; db: () => Db } {
  let conn: ReturnType<typeof openDb>;
  let harness: Harness | undefined;
  beforeAll(() => {
    conn = openDb();
  });
  afterAll(async () => {
    await conn.close();
  });
  beforeEach(async () => {
    await truncateAll(conn.db);
    harness = await Harness.start(conn.db, testSettings(overrides), createJunctionApp, junctionRegistry);
  });
  afterEach(async () => {
    await harness?.close();
  });
  return { h: () => harness!, db: () => conn.db };
}
