import { afterAll, beforeAll, beforeEach } from "vitest";

import type { Db } from "@mintrail/shared";
import { type AccountType, LedgerService, type NewAccount } from "@mintrail/ledger";

import { openDb, truncateAll } from "./db.js";

export function useLedgerDb(): {
  db: () => Db;
  ledger: () => LedgerService;
  account: (type?: AccountType, extra?: Partial<NewAccount>) => Promise<{ id: string; code: string; currency: string }>;
} {
  let conn: ReturnType<typeof openDb>;
  let n = 0;
  beforeAll(() => {
    conn = openDb();
  });
  afterAll(() => conn.close());
  beforeEach(() => truncateAll(conn.db));
  return {
    db: () => conn.db,
    ledger: () => new LedgerService(conn.db),
    account: async (type = "asset", extra = {}) => {
      n += 1;
      const seq = n;
      const currency = extra.currency ?? "INR";
      return conn.db.transaction((tx) =>
        new LedgerService(tx).createAccount({
          code: extra.code ?? `test:${type}:${seq}:${currency}`,
          name: `Test ${type} ${seq}`,
          type,
          currency,
          livemode: extra.livemode ?? false,
          allowNegative: extra.allowNegative ?? false,
          ownerId: extra.ownerId ?? null,
        }),
      );
    },
  };
}
