"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function Submit({ children, variant, confirm }: { children: ReactNode; variant?: "secondary" | "danger"; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={variant ? `btn-${variant} btn-sm` : "btn-sm"}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
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
