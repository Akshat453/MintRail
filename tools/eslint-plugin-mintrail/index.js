/**
 * MintRail ESLint rules.
 *
 * no-number-money: money is bigint minor units end to end (ADR-0002). Flags
 *   1. a `number` type on a money-named variable, parameter or property, and
 *   2. `z.number()` (or `.int()` chains on it) as the schema of a money-named property.
 */
const WORDS = ["amount", "fee", "tax", "gross", "net", "balance", "debit", "credit", "total", "subtotal"];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
// amount, amountPaid, amount_paid, maxPaymentAmount, max_payment_amount, debitsTotal, feeTotal …
const MONEY_NAME = new RegExp(
  `^(${WORDS.join("|")})(es|s)?($|_|[A-Z])|[a-z0-9](${WORDS.map(cap).join("|")})(es|s)?($|_|[A-Z])|_(${WORDS.join("|")})(es|s)?($|_)`,
);

const nameOf = (node) => {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};

const isNumberType = (typeAnnotation) => {
  const t = typeAnnotation?.typeAnnotation;
  if (!t) return false;
  if (t.type === "TSNumberKeyword") return true;
  if (t.type === "TSUnionType") return t.types.some((u) => u.type === "TSNumberKeyword");
  return false;
};

const isZodNumber = (node) => {
  let n = node;
  while (n && n.type === "CallExpression" && n.callee.type === "MemberExpression") {
    const prop = n.callee.property.name;
    if (prop === "number" && n.callee.object.type === "Identifier" && n.callee.object.name === "z") return true;
    n = n.callee.object;
  }
  return false;
};

const noNumberMoney = {
  meta: {
    type: "problem",
    docs: { description: "Forbid JS number for money; use bigint minor units (ADR-0002)." },
    messages: {
      numberType: "'{{name}}' looks like money — use bigint minor units, not number (ADR-0002).",
      zodNumber: "'{{name}}' looks like money — use a bigint schema (strictInt), not z.number() (ADR-0002).",
    },
    schema: [],
  },
  create(context) {
    const report = (node, name, messageId) => context.report({ node, messageId, data: { name } });
    const check = (keyNode, annotation, node) => {
      const name = nameOf(keyNode);
      if (name && MONEY_NAME.test(name) && isNumberType(annotation)) report(node, name, "numberType");
    };
    return {
      VariableDeclarator: (node) => check(node.id, node.id.typeAnnotation, node),
      TSPropertySignature: (node) => check(node.key, node.typeAnnotation, node),
      PropertyDefinition: (node) => check(node.key, node.typeAnnotation, node),
      Identifier: (node) => {
        const p = node.parent;
        const isParam = p && "params" in p && Array.isArray(p.params) && p.params.includes(node);
        if (isParam) check(node, node.typeAnnotation, node);
      },
      Property: (node) => {
        const name = nameOf(node.key);
        if (name && MONEY_NAME.test(name) && isZodNumber(node.value)) report(node, name, "zodNumber");
      },
    };
  },
};

export default { meta: { name: "eslint-plugin-mintrail", version: "1.0.0" }, rules: { "no-number-money": noNumberMoney } };
