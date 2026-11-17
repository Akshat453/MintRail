import type { Rule } from "eslint";

declare const plugin: { meta: { name: string; version: string }; rules: Record<"no-number-money", Rule.RuleModule> };
export default plugin;
