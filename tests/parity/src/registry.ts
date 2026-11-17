import type { Scenario } from "./scenario.js";
import audit from "./scenarios/audit.js";
import auth from "./scenarios/auth.js";
import callbacks from "./scenarios/callbacks.js";
import capture from "./scenarios/capture.js";
import idempotency from "./scenarios/idempotency.js";
import junctionApi from "./scenarios/junction_api.js";
import junction from "./scenarios/junction_scenarios.js";
import keys from "./scenarios/keys.js";
import ledger from "./scenarios/ledger.js";
import orders from "./scenarios/orders.js";
import payments from "./scenarios/payments.js";
import platform from "./scenarios/platform.js";
import ratelimit from "./scenarios/ratelimit.js";
import risk from "./scenarios/risk.js";
import staff from "./scenarios/staff.js";
import stations from "./scenarios/stations.js";
import m2Money from "./scenarios/m2_money.js";
import m2Platform from "./scenarios/m2_platform.js";

export const SCENARIOS: Scenario[] = [
  ...platform,
  ...staff,
  ...stations,
  ...keys,
  ...auth,
  ...ratelimit,
  ...idempotency,
  ...orders,
  ...payments,
  ...junction,
  ...capture,
  ...callbacks,
  ...risk,
  ...ledger,
  ...audit,
  ...junctionApi,
  // M2 regression goldens (recorded from Node; see tests/README.md)
  ...m2Money,
  ...m2Platform,
];

const ids = new Set<string>();
for (const s of SCENARIOS) {
  if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
  ids.add(s.id);
}
