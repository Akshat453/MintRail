import { SecretBox, type Settings } from "@mintrail/shared";

import type { SignalOptions } from "./delivery.js";

export const devLike = (s: Settings): boolean => s.environment === "dev" || s.environment === "test";

export function signalOptions(s: Settings): SignalOptions {
  return {
    secretBox: new SecretBox(s.secrets_key),
    maxAttempts: s.signal_max_attempts,
    backoffBaseS: s.signal_backoff_base_s,
    backoffCapS: s.signal_backoff_cap_s,
    backoffScale: s.signal_backoff_scale,
    timeoutMs: s.signal_timeout_ms,
    concurrency: s.signal_concurrency,
    graceS: s.signal_secret_grace_s,
    allowPrivate: devLike(s),
  };
}
