import Link from "next/link";

import { Field, Flash } from "@mintrail/web/ui";

import { signup } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Create your account" };

const CATEGORIES: [string, string][] = [
  ["5999", "Other retail"],
  ["5651", "Clothing and apparel"],
  ["5812", "Restaurants and food"],
  ["5411", "Groceries"],
  ["5732", "Electronics"],
  ["5734", "Software and SaaS"],
  ["8299", "Education"],
  ["4722", "Travel"],
  ["7299", "Services"],
];

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  return (
    <main className="login">
      <form action={signup} className="login-card">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>
            MintRail<small>Merchant dashboard</small>
          </span>
        </div>
        <h1>Create your MintRail account</h1>
        <p className="muted">You start in test mode. Live payments unlock once MintRail verifies your business (KYC).</p>
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <input type="hidden" name="csrf" value={await csrfToken()} />
        <Field label="Your name">
          <input name="full_name" autoComplete="name" required minLength={2} maxLength={200} placeholder="Asha Verma" />
        </Field>
        <Field label="Work email">
          <input name="email" type="email" autoComplete="email" required placeholder="you@your-company.example" />
        </Field>
        <Field label="Business name" hint="Shown to your customers and on your dashboard.">
          <input name="business_name" autoComplete="organization" required minLength={2} maxLength={100} placeholder="Asha's Bakery" />
        </Field>
        <Field label="Registered legal name" hint="Optional. Defaults to the business name.">
          <input name="legal_name" maxLength={200} placeholder="Asha Foods Private Limited" />
        </Field>
        <Field label="Business category">
          <select name="business_category" defaultValue="5999">
            {CATEGORIES.map(([mcc, label]) => (
              <option key={mcc} value={mcc}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Password" hint="At least 12 characters.">
          <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
        </Field>
        <Field label="Confirm password">
          <input name="password_confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
        </Field>
        <Submit>Create account</Submit>
        <p className="login-foot">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
