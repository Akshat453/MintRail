import type { Clock, Db, SecretBox, Settings } from "@mintrail/shared";

import type { JunctionClient } from "./junction-client.js";
import type { RateLimiter } from "./ratelimit.js";

/** Process-wide dependencies handed to every route. */
export interface AppDeps {
  settings: Settings;
  db: Db;
  secretBox: SecretBox;
  rateLimiter: RateLimiter;
  junction: JunctionClient;
  clock: Clock;
}
