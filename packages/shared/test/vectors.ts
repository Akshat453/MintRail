import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Reference outputs recorded from the M1 (Python) implementation. */
export const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../tests/parity/fixtures/python-vectors.json", import.meta.url)), "utf8"),
  // biome-ignore lint: test fixture
) as Record<string, any[]>;
