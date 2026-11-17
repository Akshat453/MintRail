/** The money lint rule itself (RuleTester through Vitest). */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import plugin from "../../../tools/eslint-plugin-mintrail/index.js";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser as never } });

tester.run("no-number-money", plugin.rules["no-number-money"] as never, {
  valid: [
    "const amount: bigint = 1n;",
    "interface P { amount: bigint; feeBps: bigint; limit: number; remaining: number }",
    "function f(amount: bigint, weight: number) {}",
    "const s = z.object({ amount: strictInt(), limit: z.number() });",
    "const body = { amount: 1000 };",
  ],
  invalid: [
    { code: "const amount: number = 1;", errors: [{ messageId: "numberType" }] },
    { code: "interface P { amountPaid: number }", errors: [{ messageId: "numberType" }] },
    { code: "type T = { max_payment_amount: number | null }", errors: [{ messageId: "numberType" }] },
    { code: "class C { debitsTotal: number = 0 }", errors: [{ messageId: "numberType" }] },
    { code: "function f(fee: number) {}", errors: [{ messageId: "numberType" }] },
    { code: "const s = z.object({ amount: z.number().int() });", errors: [{ messageId: "zodNumber" }] },
    { code: "const s = { gross: z.number() };", errors: [{ messageId: "zodNumber" }] },
  ],
});
