import type { Ctx } from "./ctx.js";

export interface Scenario {
  id: string;
  /** M2 scenarios also snapshot the M2 tables (M1 goldens stay byte-identical). */
  m2: boolean;
  run(ctx: Ctx): Promise<void>;
}

export const scenario = (id: string, run: (ctx: Ctx) => Promise<void>, opts: { m2?: boolean } = {}): Scenario => ({
  id,
  run,
  m2: opts.m2 ?? false,
});
