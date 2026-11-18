import { Field, Flash } from "@mintrail/web/ui";

import { login } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  return (
    <main className="login">
      <form action={login} className="login-card">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>
            MintRail<small>Merchant dashboard</small>
          </span>
        </div>
        <h1>Sign in to your account</h1>
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <input type="hidden" name="csrf" value={await csrfToken()} />
        <Field label="Work email">
          <input name="email" type="email" autoComplete="username" required placeholder="owner@your-company.example" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Submit>Sign in</Submit>
        <p className="login-foot">
          MintRail is a fictional company. Seeded logins: <code>owner@&lt;merchant&gt;.example</code> / see{" "}
          <code>.mintrail/demo-keys.json</code>.
        </p>
      </form>
    </main>
  );
}
