"use client";
/** The few interactive bits: pending buttons and one-time secret reveal (secrets never touch the URL). */
import { usePathname } from "next/navigation";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

import type { SecretState } from "@/app/actions";

export function Submit({ children, variant, confirm }: { children: ReactNode; variant?: "secondary" | "danger"; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={variant ? `btn-${variant}` : undefined}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function SecretForm({
  action,
  csrf,
  idem,
  hidden,
  children,
  button,
  what,
}: {
  action: (prev: SecretState, form: FormData) => Promise<SecretState>;
  csrf: string;
  idem: string;
  hidden?: Record<string, string>;
  children?: ReactNode;
  button: string;
  what: string;
}) {
  const [state, run] = useActionState(action, {});
  return (
    <form action={run} className="stack">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="idem" value={idem} />
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      {state.error && (
        <div className="flash flash-err" role="alert">
          {state.error}
        </div>
      )}
      {state.secret ? (
        <div className="stack" data-testid="secret-once">
          <div className="flash flash-ok">
            {what} created ({state.id}). Copy it now — MintRail will not show it again.
          </div>
          <div className="secret">{state.secret}</div>
          <a href="" className="btn btn-secondary btn-sm">
            Done
          </a>
        </div>
      ) : (
        <Submit>{button}</Submit>
      )}
    </form>
  );
}

export function NavLinks({ items }: { items: [string, string][] }) {
  const path = usePathname();
  return (
    <nav className="nav">
      {items.map(([href, label]) => (
        <a key={href} href={href} className={(href === "/" ? path === "/" : path.startsWith(href)) ? "active" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
