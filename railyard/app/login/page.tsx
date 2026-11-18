import { Field, Flash } from "@mintrail/web/ui";

import { login } from "@/app/actions";
import { Submit } from "@/components/client";
import { csrfToken, one, type SearchParams } from "@/lib/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  return (
    <main className="login alt">
      <form action={login} className="login-card">
        <div className="brand">
          <span className="brand-mark alt">R</span>
          <span>
            Railyard<small>MintRail staff only</small>
          </span>
        </div>
        <h1>Staff sign in</h1>
        <Flash msg={one(sp.msg)} err={one(sp.err)} />
        <input type="hidden" name="csrf" value={await csrfToken()} />
        <Field label="Staff email">
          <input name="email" type="email" autoComplete="username" required placeholder="you@mintrail.example" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Submit>Sign in</Submit>
        <p className="login-foot">Every action you take here is recorded in the staff audit log.</p>
      </form>
    </main>
  );
}
