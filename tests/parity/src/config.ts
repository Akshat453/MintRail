/** Parity harness configuration (environment variables, with local-stack defaults). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const cfg = {
  apiUrl: env("PARITY_API_URL", "http://localhost:18000"),
  junctionUrl: env("PARITY_JUNCTION_URL", "http://localhost:18100"),
  dbUrl: env("PARITY_DB_URL", "postgres://mintrail:mintrail@localhost:15432/mintrail"),
  junctionApiKey: env("PARITY_JUNCTION_API_KEY", "change-me-junction-api-key"),
  callbackSecret: env("PARITY_JUNCTION_CALLBACK_SECRET", "change-me-junction-callback-secret"),
  // M2
  depotUrl: env("PARITY_DEPOT_URL", "http://localhost:18300"),
  depotApiKey: env("PARITY_DEPOT_API_KEY", "change-me-depot-api-key"),
  /** How the (Dockerised) Signal worker reaches webhook receivers the harness starts on this host. */
  receiverHost: env("PARITY_RECEIVER_HOST", "host.docker.internal"),
  record: process.env.PARITY_RECORD === "1",
  only: process.env.PARITY_ONLY ? new RegExp(process.env.PARITY_ONLY) : undefined,
  goldenDir: `${ROOT}golden`,
  actualDir: `${ROOT}.actual`,
};

interface Vectors {
  passwords: { password: string; hash: string }[];
}
const vectors = JSON.parse(readFileSync(`${ROOT}fixtures/python-vectors.json`, "utf8")) as Vectors;

/** Staff password + a scrypt hash produced by the M1 (Python) implementation. */
export const STAFF_PASSWORD = vectors.passwords[0]!.password;
export const STAFF_PASSWORD_HASH = vectors.passwords[0]!.hash;
