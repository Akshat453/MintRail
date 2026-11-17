/**
 * Structured logging (pino) with request/job correlation via AsyncLocalStorage.
 * Secrets, keys, signatures and passwords are redacted at the logger level.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { pino, type Logger } from "pino";

export interface LogContext {
  request_id?: string;
  job_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

export const REDACT_PATHS = [
  "authorization",
  "password",
  "secret",
  "token",
  "signature",
  "signing_key",
  "api_key",
  "*.authorization",
  "*.password",
  "*.secret",
  "*.token",
  "*.signature",
  "*.signing_key",
  "*.api_key",
  "headers.authorization",
  'headers["mintrail-signature"]',
  'headers["junction-signature"]',
  "req.headers.authorization",
  'req.headers["mintrail-signature"]',
  'req.headers["junction-signature"]',
];

export function createLogger(opts: { level?: string; json?: boolean; name?: string } = {}): Logger {
  return pino({
    name: opts.name,
    level: (opts.level ?? "info").toLowerCase(),
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const ctx = logContext.getStore();
      return ctx ? { ...ctx } : {};
    },
    transport: opts.json === false ? { target: "pino/file", options: { destination: 1 } } : undefined,
  });
}

export let log: Logger = createLogger({ level: process.env.MINTRAIL_LOG_LEVEL ?? "info" });

export function configureLogging(level: string, json: boolean): Logger {
  log = createLogger({ level, json });
  return log;
}
